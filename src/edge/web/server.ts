import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { getProject } from "../../projects"
import { page, SCRIPT } from "./html"
import { createPages } from "./pages"

export { page } from "./html"

// Read-only dashboard, server-rendered, no login: it binds 127.0.0.1 only. Every piece of stored text is escaped.
// The CSP allows one script, the static SCRIPT constant, by its hash, and fonts from this server only.
export const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; script-src 'sha256-${createHash("sha256").update(SCRIPT).digest("base64")}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
}

// Self-hosted OFL fonts (licences next to them), read once.
const FONTS = new Map(
  ["geist"].map((name) => [`/fonts/${name}.woff2`, readFileSync(new URL(`./fonts/${name}.woff2`, import.meta.url))]),
)
const FONT_HEADERS = {
  "content-type": "font/woff2",
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
}

/** The response for a self-hosted font file, or undefined for any other path. */
export const font = (path: string) => {
  const file = FONTS.get(path)
  return file ? new Response(file, { headers: FONT_HEADERS }) : undefined
}

export const dashboard = (db: Database) => {
  const pages = createPages(db)
  return (req: Request): Response => {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405, headers: { allow: "GET, HEAD" } })
    const path = new URL(req.url).pathname
    const file = font(path)
    if (file) return file
    const html = (body: string, status = 200) => new Response(body, { status, headers: HEADERS })
    if (path === "/") return html(pages.index())
    const m = /^\/p\/([^/]+)$/.exec(path)
    let id: string | null = null
    try {
      id = m && decodeURIComponent(m[1]!)
    } catch {
      // A malformed escape names no project: 404 below.
    }
    const project = id && getProject(db, id)
    if (project) return html(pages.project(project))
    return html(page("Not found - gtmkit", `<div class="head"><h1>Not found</h1><p><a href="/">All projects</a></p></div>`), 404)
  }
}

/**
 * The dashboard on 127.0.0.1, with no login, so any other address is refused. The connection is set query-only:
 * a page cannot write. Requests whose Host is not this loopback address are refused (DNS rebinding).
 */
export const serveDashboard = (db: Database, { hostname = "127.0.0.1", port = 8787 } = {}) => {
  if (hostname !== "127.0.0.1") throw new Error(`refused: gtmkit serve has no login and binds 127.0.0.1 only, not ${hostname}`)
  db.run("PRAGMA query_only = ON")
  const handle = dashboard(db)
  return Bun.serve({
    hostname,
    port,
    fetch: (req, server) => {
      const hosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`]
      if (!hosts.includes(req.headers.get("host") ?? "")) return new Response("refused: unexpected Host header", { status: 403 })
      try {
        return handle(req)
      } catch (e) {
        console.error(e)
        return new Response("internal error, see the gtmkit serve log", { status: 500 })
      }
    },
  })
}
