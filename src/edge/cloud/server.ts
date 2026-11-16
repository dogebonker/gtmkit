import { createMcpHandler } from "@modelcontextprotocol/server"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { dbHealthy, openDb } from "../../db"
import { createSignals, type Providers } from "../../signals"
import { createServer } from "../mcp/server"
import { dashboard, font, HEADERS, page } from "../web/server"

// `gtmkit serve --public`: MCP over streamable HTTP at /mcp behind a bearer token, the dashboard behind a login form,
// /health without auth, and a daily runDue() timer, in one process. TLS is terminated by the platform's proxy: this
// process speaks plain HTTP. The Host header is not checked: every route but /health needs the token or the cookie,
// which a page rebound to this address cannot present.
const COOKIE = "gtmkit_session"
const DAY_MS = 86_400_000
const MIN_TOKEN_CHARS = 32
const MAX_BODY_BYTES = 1024 * 1024
const LOGIN_HEADERS = { ...HEADERS, "content-security-policy": HEADERS["content-security-policy"].replace("form-action 'none'", "form-action 'self'") }

const digest = (s: string) => createHash("sha256").update(s).digest()
/** Constant time, whatever the lengths. */
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b))

/**
 * Runs `run` now, then `intervalMs` after each run ends: two runs never overlap, and a failing run is logged and
 * the next one still comes. Returns the stop function.
 */
export const everyInterval = (run: () => Promise<unknown>, intervalMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const loop = async () => {
    try {
      await run()
    } catch (e) {
      console.error("scheduled runDue failed:", e)
    }
    if (!stopped) timer = setTimeout(loop, intervalMs)
  }
  timer = setTimeout(loop, 0)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

const loginForm = (status: number, message = "") =>
  new Response(
    page(
      "Log in - gtmkit",
      `<div class="head"><h1>gtmkit</h1>${message ? `<p class="warn">${message}</p>` : ""}
<form method="post" action="/login"><label>Token <input type="password" name="token" autocomplete="current-password" required autofocus></label>
<button type="submit">Log in</button></form></div>`,
    ),
    { status, headers: LOGIN_HEADERS },
  )

export const servePublic = (opts: {
  dbPath: string
  providers: Providers
  token: string | undefined
  hostname?: string
  port?: number
  intervalMs?: number
}) => {
  const { dbPath, providers, token } = opts
  if (!token) throw new Error("refused: gtmkit serve --public needs GTMKIT_TOKEN")
  if (token.length < MIN_TOKEN_CHARS) throw new Error(`refused: GTMKIT_TOKEN must have at least ${MIN_TOKEN_CHARS} characters`)
  // The cookie holds an HMAC of a fixed label under the token: it proves the login without being the token.
  const session = createHmac("sha256", token).update("gtmkit dashboard session").digest("base64url")

  const db = openDb(dbPath)
  // The dashboard gets its own query-only connection, as in local mode.
  const readOnly = openDb(dbPath)
  readOnly.run("PRAGMA query_only = ON")
  const pages = dashboard(readOnly)
  const mcp = createMcpHandler(() => createServer(db, providers, { prompts: true }))
  const signals = createSignals(db, providers)
  const stopTimer = everyInterval(() => signals.runDue(), opts.intervalMs ?? DAY_MS)

  const route = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname
    if (path === "/health") {
      const ok = dbHealthy(dbPath)
      return Response.json({ ok }, { status: ok ? 200 : 503 })
    }
    if (path === "/mcp") {
      const auth = req.headers.get("authorization") ?? ""
      if (!same(auth, `Bearer ${token}`)) {
        return new Response("unauthorized", { status: 401, headers: { "www-authenticate": 'Bearer realm="gtmkit"' } })
      }
      return mcp.fetch(req)
    }
    if (path === "/login" && req.method === "POST") {
      const given = (await req.formData().catch(() => null))?.get("token")
      if (typeof given !== "string" || !same(given, token)) return loginForm(401, "Wrong token.")
      return new Response(null, {
        status: 303,
        headers: { location: "/", "set-cookie": `${COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Strict` },
      })
    }
    if (path === "/login") return loginForm(200)
    // The self-hosted fonts are public files: the login page needs them before there is a cookie.
    const file = req.method === "GET" || req.method === "HEAD" ? font(path) : undefined
    if (file) return file
    const cookie = /(?:^|;\s*)gtmkit_session=([^;]*)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? ""
    if (!same(cookie, session)) return loginForm(401)
    return pages(req)
  }

  const server = Bun.serve({
    hostname: opts.hostname ?? "0.0.0.0",
    port: opts.port ?? 8787,
    // Bun's default of 10 s would cut off an interactive collection, which may take up to 125 s.
    idleTimeout: 255,
    // Bun's default is 128 MB, and /login parses its body before the token check.
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: async (req) => {
      try {
        return await route(req)
      } catch (e) {
        console.error(e)
        return new Response("internal error, see the gtmkit serve log", { status: 500 })
      }
    },
  })
  return {
    url: server.url,
    stop: async () => {
      stopTimer()
      await mcp.close()
      await server.stop(true)
    },
  }
}
