import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "vite-plus/test"
import { createActions } from "../src/actions"
import { openDb } from "../src/db"
import { briefPrompt } from "../src/edge/cli/headless"
import { upsertProject } from "../src/projects"
import { createSignals } from "../src/signals"
import { fakeDataForSEO, fakeSearchConsole, fakeWeb } from "./fake-provider"

const run = (args: string[], home: string, env: Record<string, string> = {}) =>
  Bun.spawnSync([process.execPath, "src/edge/cli/main.ts", ...args], {
    stdin: new TextEncoder().encode("1000000\n1000000\ny\n"),
    env: { PATH: process.env.PATH ?? "", GTMKIT_HOME: home, ...env },
  })

describe("tick, status and schedule", () => {
  test("gtmkit tick records the run, and gtmkit status shows it with halts, spend against caps and coverage", () => {
    const home = mkdtempSync(join(tmpdir(), "gtmkit-"))
    const db = openDb(join(home, "gtmkit.db"))
    const signals = createSignals(db, { dataforseo: null })
    signals.setCap("global", 150)
    signals.setCap("default", 30)
    signals.setCap("halt:serp_top30", 0.01)
    // The domain (ai_access) and the URL (page_watch) are refused by the fetcher guard: no network.
    const project = upsertProject(db, { domain: "10.0.0.1", location: "United States", language: "English", urls: ["http://10.0.0.1/"] })
    const env = { GTMKIT_NOW: "2026-11-15T08:00:00.000Z" }

    expect(run(["status"], home, env).stdout.toString()).toContain("last tick: never")
    const tick = run(["tick"], home, env)
    expect(tick.exitCode, tick.stderr.toString()).toBe(0)

    const out = run(["status"], home, env).stdout.toString()
    expect(out).toContain("last tick: 2026-11-15T08:00:00.000Z")
    expect(out).toContain("halts: halt:serp_top30")
    expect(out).toContain("2026-11 spend: $0.00 of global cap $150.00")
    expect(out).toContain(`project ${project.id}: $0.00 of cap $30.00`)
    expect(out).toContain("page_watch: 0/1 this week")
  })

  test("gtmkit schedule install writes a daily launchd job running tick, and uninstall removes it", () => {
    const home = mkdtempSync(join(tmpdir(), "gtmkit-"))
    const agents = mkdtempSync(join(tmpdir(), "gtmkit-agents-"))
    const env = { GTMKIT_LAUNCH_AGENTS_DIR: agents }
    const plist = join(agents, "com.gtmkit.tick.plist")

    expect(run(["schedule", "install"], home, env).exitCode).toBe(0)
    const xml = readFileSync(plist, "utf8")
    expect(xml).toContain("<string>tick</string>")
    expect(xml).toContain("<key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer>")
    expect(xml).toContain(`<key>GTMKIT_HOME</key><string>${home}</string>`)
    expect(xml).toContain(`<key>PATH</key><string>${process.env.PATH}</string>`) // tick finds claude under launchd
    if (process.platform === "darwin") expect(Bun.spawnSync(["plutil", "-lint", plist]).exitCode).toBe(0)

    expect(run(["schedule", "uninstall"], home, env).exitCode).toBe(0)
    expect(existsSync(plist)).toBe(false)
  })
})

describe("weekly brief", () => {
  test("AC10: tick starts the restricted headless brief for each project without one this week, without an Anthropic API key", async () => {
    const home = mkdtempSync(join(tmpdir(), "gtmkit-"))
    const db = openDb(join(home, "gtmkit.db"))
    const world = { round: 0 }
    const signals = createSignals(db, { dataforseo: fakeDataForSEO({ world }).dataforseo, gsc: fakeSearchConsole(world).gsc, web: fakeWeb(world).web })
    signals.setCap("global", 150)
    signals.setCap("default", 30)
    const profile = { location: "United States", language: "English", keywords: [{ value: "simple crm" }] }
    const due = upsertProject(db, { id: "due", domain: "example.com", ...profile })
    const briefed = upsertProject(db, { id: "briefed", domain: "other.com", ...profile })
    const now = "2026-11-16T08:00:00.000Z" // 2026-W47
    process.env.GTMKIT_NOW = now
    await signals.runDue() // this week's data is in: the CLI's runDue finds nothing due and needs no credentials
    const actions = createActions(db, signals)
    actions.saveBrief(briefed.id, "2026-W47", "# Already written")

    writeFileSync(join(home, "credentials"), JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: "subscription-token" }), { mode: 0o600 })
    const claude = join(home, "claude")
    writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${resolve("test/fixtures/fake-claude.ts")}" "$@"\n`)
    chmodSync(claude, 0o755)
    const log = join(home, "claude.log")
    const env = { GTMKIT_NOW: now, GTMKIT_CLAUDE_BIN: claude, FAKE_CLAUDE_LOG: log, ANTHROPIC_API_KEY: "sk-ant-must-not-pass", ANTHROPIC_AUTH_TOKEN: "x" }

    const tick = run(["tick"], home, env)
    expect(tick.exitCode, tick.stderr.toString()).toBe(0)

    const starts = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(starts).toHaveLength(1)
    const [start] = starts
    const mcpConfig = JSON.stringify({
      mcpServers: {
        gtmkit: {
          command: process.execPath,
          args: [resolve("src/edge/cli/main.ts"), "mcp", "--brief-only"],
          env: { GTMKIT_HOME: home, GTMKIT_NOW: now },
        },
      },
    })
    expect(start.args).toEqual([
      "-p",
      briefPrompt(due.id),
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfig,
      "--allowedTools",
      "mcp__gtmkit__*",
      "--output-format",
      "stream-json",
      "--verbose",
    ])
    expect(start.args[1]).toContain("The project id is `due`")
    expect(start.args[1]).not.toContain("allowed-tools") // frontmatter stripped
    expect(start.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "subscription-token" })

    expect(actions.latestBrief(due.id)).toMatchObject({ period: "2026-W47", markdown: expect.stringContaining("# Brief 2026-W47") })
    expect(db.query("SELECT count(*) AS n FROM briefs WHERE project_id = ?").get(briefed.id)).toEqual({ n: 1 })
    const transcripts = readdirSync(join(home, "logs")).filter((f) => f.startsWith(`brief-${due.id}-`))
    expect(transcripts).toHaveLength(1)
    const lines = readFileSync(join(home, "logs", transcripts[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(lines[0].tools.sort()).toEqual(
      ["actions_list", "actions_propose", "brief_save", "digest", "project_get", "signals_query"].map((t) => `mcp__gtmkit__${t}`),
    )

    expect(run(["tick"], home, env).exitCode).toBe(0)
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1) // every project has this week's brief

    expect(run(["brief", due.id], home).stdout.toString()).toContain("# Brief 2026-W47")
    expect(run(["brief", "nope"], home).exitCode).toBe(1)
  })

  test("gtmkit status shows the latest brief and the action acceptance rate per project", () => {
    const home = mkdtempSync(join(tmpdir(), "gtmkit-"))
    const db = openDb(join(home, "gtmkit.db"))
    const signals = createSignals(db, { dataforseo: null })
    const project = upsertProject(db, { domain: "example.com", location: "United States", language: "English" })
    db.run(
      `INSERT INTO snapshots (project_id, kind, subject, bucket, params_hash, status, captured_at, payload)
       VALUES (?, 'keyword_gap', 'rival.com', '1', 'h', 'ok', '2026-11-10T00:00:00.000Z', '{"items":[]}')`,
      [project.id],
    )
    const actions = createActions(db, signals)
    const target = { kind: "keyword_gap", subject: "rival.com", key: "gap_keywords" }
    for (const steps of [["accepted"], ["accepted", "done"], ["dropped"], ["accepted"], []] as const) {
      const a = actions.propose(project.id, { title: "t", rationale: "r", evidence: [1], target })
      for (const step of steps) actions.update(project.id, a.id, step)
    }
    process.env.GTMKIT_NOW = "2026-11-15T08:00:00.000Z"
    actions.saveBrief(project.id, "2026-W46", "# W46")

    const out = run(["status"], home).stdout.toString()
    expect(out).toContain("  latest brief: 2026-W46 (2026-11-15T08:00:00.000Z)")
    expect(out).toContain("  actions accepted: 3 of 4 decided (75%)")
  })
})

describe("AC2: caps are written only from a terminal", () => {
  test.each([["budget"], ["budget", "--clear-halt"], ["budget", "--project", "p1"], ["init"]])(
    "gtmkit %s refuses when stdin is not a terminal",
    (...args) => {
      const home = mkdtempSync(join(tmpdir(), "gtmkit-"))
      const signals = createSignals(openDb(join(home, "gtmkit.db")), { dataforseo: null })
      signals.setCap("global", 150)
      signals.setCap("default", 30)
      signals.setCap("halt:keyword_ideas", 1)
      const before = signals.caps()

      const r = run(args, home)

      expect(r.exitCode).toBe(1)
      expect(r.stderr.toString()).toContain("stdin is not one")
      expect(signals.caps()).toEqual(before)
    },
  )
})
