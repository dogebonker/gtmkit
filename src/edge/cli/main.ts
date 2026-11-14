#!/usr/bin/env bun
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { createActions } from "../../actions"
import { openDb } from "../../db"
import { credentialsPath, dbPath, home, now, readCredentials } from "../../env"
import { listProjectIds } from "../../projects"
import { bucketOf, createSignals, dataForSEO, type Providers, searchConsole } from "../../signals"
import { servePublic } from "../cloud/server"
import { createServer } from "../mcp/server"
import { serveDashboard } from "../web/server"
import { runBrief } from "./headless"

const USAGE = `usage:
  gtmkit init                     create ~/.gtmkit, store DataForSEO credentials, set the global and default caps
  gtmkit budget                   set the global and default monthly caps (USD)
  gtmkit budget --project <id>    set one project's monthly cap
  gtmkit budget --clear-halt      clear halts written after a charge above its estimate
  gtmkit mcp [--brief-only]       run the MCP server on stdio (--brief-only: the six tools of the weekly brief)
  gtmkit tick                     collect what is due this week, then write each missing weekly brief (launchd runs this daily)
  gtmkit schedule install         add the daily launchd job that runs gtmkit tick
  gtmkit schedule uninstall       remove it
  gtmkit status                   last tick, halts, this month's spend against the caps, coverage, briefs, acceptance
  gtmkit brief <project>          print the latest brief of a project
  gtmkit rebuild-metrics          recompute the metrics table from the stored snapshots
  gtmkit serve [--port <n>]       read-only dashboard on http://127.0.0.1:8787, no login
  gtmkit serve --public [--port <n>]
                                  container mode on 0.0.0.0: HTTP MCP at /mcp and the dashboard, both behind
                                  GTMKIT_TOKEN, /health, and runDue() daily`

const LABEL = "com.gtmkit.tick"

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

/** Caps are written only from a terminal: an agent piping input must not be able to change them. */
const requireTerminal = (command: string) => {
  if (!process.stdin.isTTY) fail(`refused: gtmkit ${command} asks in a terminal, and stdin is not one`)
}

const ask = (question: string, current?: number): number | undefined => {
  const answer = prompt(`${question}${current === undefined ? "" : ` [${current}]`}:`)?.trim()
  if (!answer) return current
  const n = Number(answer)
  if (!Number.isFinite(n) || n < 0) fail(`not a dollar amount: ${answer}`)
  return n
}

/** prompt() with terminal echo off. */
const askSecret = (question: string): string | undefined => {
  const stty = (arg: string) => Bun.spawnSync(["stty", arg], { stdin: "inherit" })
  stty("-echo")
  try {
    return prompt(question)?.trim()
  } finally {
    stty("echo")
    console.log()
  }
}

const providers = (): Providers => {
  const c = readCredentials()
  return {
    dataforseo: c.dataforseo ? dataForSEO(c.dataforseo) : null,
    gsc: c.google ? searchConsole(c.google) : null,
  }
}

const signals = (p: Providers = { dataforseo: null }) => createSignals(openDb(dbPath()), p)

const askCaps = (s: ReturnType<typeof signals>, scopes: [string, string][]) => {
  const current = new Map(s.caps().map((c) => [c.scope, c.usd]))
  for (const [scope, question] of scopes) {
    const usd = ask(question, current.get(scope))
    if (usd !== undefined) s.setCap(scope, usd)
  }
  for (const c of s.caps()) console.log(`${c.scope}: $${c.usd}`)
}

const money = (n: number | null) => (n === null ? "none" : `$${n.toFixed(2)}`)

// The job gets the installing shell's PATH so tick finds `claude` (and its runtime) under launchd.
// GTMKIT_LAUNCH_AGENTS_DIR redirects the plist and skips launchctl, so tests never touch the real launchd.
const launchAgentsDir = process.env.GTMKIT_LAUNCH_AGENTS_DIR
const plistPath = () => join(launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents"), `${LABEL}.plist`)
const launchctl = (...args: string[]) => (launchAgentsDir ? null : Bun.spawnSync(["launchctl", ...args]))
const domain = () => `gui/${process.getuid?.() ?? 0}`
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const plist = () => {
  const logs = join(home(), "logs")
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  const args = [process.execPath, import.meta.path, "tick"].map((a) => `<string>${xml(a)}</string>`).join("")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>EnvironmentVariables</key><dict><key>GTMKIT_HOME</key><string>${xml(home())}</string><key>PATH</key><string>${xml(process.env.PATH ?? "")}</string></dict>
  <key>StandardOutPath</key><string>${xml(join(logs, "tick.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logs, "tick.log"))}</string>
</dict>
</plist>
`
}

const [command, ...args] = process.argv.slice(2)

switch (command) {
  case "init": {
    requireTerminal("init")
    mkdirSync(home(), { recursive: true, mode: 0o700 })
    const login = prompt("DataForSEO API login:")?.trim()
    const password = askSecret("DataForSEO API password:")
    if (!login || !password) fail("refused: login and password are required")
    const path = credentialsPath()
    const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {}
    writeFileSync(path, JSON.stringify({ ...existing, dataforseo: { login, password } }, null, 2), { mode: 0o600 })
    chmodSync(path, 0o600)
    console.log(`wrote ${path}`)
    askCaps(signals(), [
      ["global", "Global cap, USD per month for all projects"],
      ["default", "Default cap, USD per month per project"],
    ])
    break
  }
  case "budget": {
    requireTerminal("budget")
    const s = signals()
    if (args[0] === "--clear-halt") {
      const halts = s.caps().filter((c) => c.scope.startsWith("halt:"))
      if (halts.length === 0) break
      console.log(halts.map((h) => `${h.scope} (charged $${h.usd})`).join("\n"))
      if (prompt("Clear these halts? Update src/signals/prices.ts first. [y/N]:")?.trim().toLowerCase() === "y") {
        console.log(`cleared ${s.clearHalts()}`)
      }
    } else if (args[0] === "--project") {
      const id = args[1] ?? fail(USAGE)
      askCaps(s, [[id, `Cap for project ${id}, USD per month`]])
    } else {
      askCaps(s, [
        ["global", "Global cap, USD per month for all projects"],
        ["default", "Default cap, USD per month per project"],
      ])
    }
    break
  }
  case "mcp": {
    const db = openDb(dbPath())
    // The brief-only server cannot collect, so it gets no provider credentials either.
    const briefOnly = args[0] === "--brief-only"
    const p = briefOnly ? { dataforseo: null } : providers()
    serveStdio(() => createServer(db, p, { briefOnly }))
    break
  }
  case "tick": {
    const db = openDb(dbPath())
    const s = createSignals(db, providers())
    console.log(JSON.stringify(await s.runDue(), null, 1))
    // runDue has finished for every project: each one without a brief this week gets one.
    const actions = createActions(db, s)
    const week = bucketOf("weekly", now())
    for (const id of listProjectIds(db)) {
      if (actions.latestBrief(id)?.period === week) continue
      try {
        const run = await runBrief(id)
        console.log(JSON.stringify({ brief: id, period: week, stored: actions.latestBrief(id)?.period === week, ...run }))
      } catch (e) {
        console.error(`brief for ${id} did not start: ${(e as Error).message}`)
      }
    }
    break
  }
  case "schedule": {
    const path = plistPath()
    if (args[0] === "install") {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, plist())
      launchctl("bootout", `${domain()}/${LABEL}`)
      const r = launchctl("bootstrap", domain(), path)
      if (r && r.exitCode !== 0) fail(`launchctl bootstrap failed: ${r.stderr.toString()}`)
      console.log(`installed ${path}: gtmkit tick runs daily at 09:00, and on wake if that time was missed`)
    } else if (args[0] === "uninstall") {
      launchctl("bootout", `${domain()}/${LABEL}`)
      rmSync(path, { force: true })
      console.log(`removed ${path}`)
    } else {
      fail(USAGE)
    }
    break
  }
  case "status": {
    const db = openDb(dbPath())
    const sig = createSignals(db, { dataforseo: null })
    const s = sig.status()
    const actions = createActions(db, sig)
    console.log(`last tick: ${s.last_tick ?? "never"}`)
    console.log(`halts: ${s.halts.length ? s.halts.join(", ") : "none"}`)
    console.log(`${s.month} spend: ${money(s.global.spent_usd)} of global cap ${money(s.global.cap_usd)}`)
    for (const p of s.projects) {
      console.log(`project ${p.id}: ${money(p.spent_usd)} of cap ${money(p.cap_usd)}`)
      for (const [kind, c] of Object.entries(p.coverage)) console.log(`  ${kind}: ${c.collected}/${c.expected} this week`)
      const brief = actions.latestBrief(p.id)
      console.log(`  latest brief: ${brief ? `${brief.period} (${brief.created_at})` : "none"}`)
      const a = actions.acceptance(p.id)
      console.log(
        `  actions accepted: ${a.rate === null ? "none decided" : `${a.accepted} of ${a.decided} decided (${Math.round(a.rate * 100)}%)`}`,
      )
    }
    break
  }
  case "brief": {
    const id = args[0] ?? fail(USAGE)
    const db = openDb(dbPath())
    const brief = createActions(db, createSignals(db, { dataforseo: null })).latestBrief(id)
    if (!brief) fail(`no brief for project ${id}`)
    console.log(brief!.markdown)
    break
  }
  case "serve": {
    const at = args.indexOf("--port")
    const port = at === -1 ? 8787 : Number(args[at + 1])
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail(USAGE)
    if (args.includes("--public")) {
      try {
        const server = servePublic({ dbPath: dbPath(), providers: providers(), token: process.env.GTMKIT_TOKEN, port })
        console.log(`gtmkit public server on ${server.url} (MCP at /mcp)`)
      } catch (e) {
        fail((e as Error).message)
      }
      break
    }
    const server = serveDashboard(openDb(dbPath()), { port })
    console.log(`gtmkit dashboard on ${server.url}`)
    break
  }
  case "rebuild-metrics": {
    console.log(`rebuilt metrics from ${signals().rebuildMetrics()} snapshots`)
    break
  }
  default:
    fail(USAGE)
}
