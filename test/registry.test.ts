import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "vite-plus/test"
import { openDb } from "../src/db"
import { createSignals } from "../src/signals"

// A new kind, written the way an owner would add one: one file in src/signals/collectors, nothing else.
const PROBE = `import { Effect } from "effect"
import type { Collector } from "../collector"

const collector: Collector<{ n: number }, { items: { n: number }[] }, "web"> = {
  kind: "probe_kind",
  schedule: "weekly",
  provider: "web",
  subjects: () => ["probe"],
  request: () => ({ subject: "probe", params: { n: 7 } }),
  estimate: () => 0,
  fetch: (p) => Effect.succeed({ payload: { items: [{ n: p.n }] }, costUsd: 0 }),
  extract: (payload) => [{ subject: "probe", key: "n", date: "2026-11-15", value: payload.items[0]!.n }],
  diff: () => [],
}

export default collector
`

test("AC12: one new collector file makes its kind collectable, queryable and present in digest", async () => {
  // A copy of src inside the repo (so node_modules resolves), with the probe added there and nowhere else.
  const repo = resolve(import.meta.dirname, "..")
  mkdirSync(join(repo, "node_modules", ".cache"), { recursive: true })
  const root = mkdtempSync(join(repo, "node_modules", ".cache", "gtmkit-ac12-"))
  const home = mkdtempSync(join(tmpdir(), "gtmkit-ac12-home-"))
  try {
    cpSync(join(repo, "src"), join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src", "signals", "collectors", "probe_kind.ts"), PROBE)
    const signals = createSignals(openDb(join(home, "gtmkit.db")), { dataforseo: null })
    signals.setCap("global", 150)
    signals.setCap("default", 30)

    const client = new Client({ name: "test", version: "0" })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "src", "edge", "cli", "main.ts"), "mcp"],
        env: { PATH: process.env.PATH ?? "", GTMKIT_HOME: home, GTMKIT_NOW: "2026-11-15T08:00:00.000Z" },
      }),
    )
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
        expect(r.isError, r.content[0]!.text).toBeFalsy()
        return JSON.parse(r.content[0]!.text)
      }
      const project = await call("project_upsert", { domain: "example.com", location: "United States", language: "English" })
      expect((await call("signals_collect", { project_id: project.id, kind: "probe_kind" })).status).toBe("collected")
      const { snapshots } = await call("signals_query", { project_id: project.id, kind: "probe_kind" })
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0].untrusted_provider_data).toEqual(['{"n":7}'])
      const digest = await call("digest", { project_id: project.id })
      expect(digest.kinds.probe_kind).toEqual({ coverage: { collected: 1, expected: 1 }, changes: [] })
    } finally {
      await client.close()
    }
    expect(openDb(join(home, "gtmkit.db")).query("SELECT key, value FROM metrics WHERE kind = 'probe_kind'").all()).toEqual([
      { key: "n", value: 7 },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
