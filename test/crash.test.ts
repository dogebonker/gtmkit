import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vite-plus/test"
import { openDb } from "../src/db"
import { upsertProject } from "../src/projects"
import { createSignals } from "../src/signals"

const BASE = Date.parse("2026-11-15T08:00:00.000Z")
const MAX_ROUNDS = 40

test("AC4: killing collections at random points never leaves the ledger below the provider's charges", async () => {
  const home = mkdtempSync(join(tmpdir(), "gtmkit-crash-"))
  const chargesFile = join(home, "charges")
  const db = openDb(join(home, "gtmkit.db"))
  const signals = createSignals(db, { dataforseo: null })
  signals.setCap("global", 150)
  signals.setCap("default", 30)
  const project = upsertProject(db, { domain: "example.com", location: "United States", language: "English" })

  // Each round starts 11 minutes after the previous one, so the claims it left are takeover candidates.
  const worker = (round: number) =>
    Bun.spawn([process.execPath, "test/fixtures/collect-worker.ts"], {
      env: {
        PATH: process.env.PATH ?? "",
        GTMKIT_HOME: home,
        GTMKIT_NOW: new Date(BASE + round * 11 * 60_000).toISOString(),
        CHARGES_FILE: chargesFile,
        PROJECT_ID: project.id,
      },
      stderr: "pipe",
    })

  // Kill each run at a random point until one run finishes all 50 collections.
  let killed = 0
  let round = 0
  for (; round < MAX_ROUNDS; round++) {
    const proc = worker(round)
    await Promise.race([proc.exited, Bun.sleep(150 + Math.random() * 350)])
    if (proc.exitCode !== null) break
    proc.kill("SIGKILL")
    await proc.exited
    killed++
  }

  // The rerun 11 minutes after the last kill must not be blocked by any claim it left.
  const final = worker(round + 1)
  const code = await final.exited
  expect(code, await new Response(final.stderr).text()).toBe(0)

  // One line per charged call, with the task sent: keyword_ideas sends the seed as keywords[0].
  const charges = (existsSync(chargesFile) ? readFileSync(chargesFile, "utf8").trim().split("\n").filter(Boolean) : []).map(
    (line) => JSON.parse(line) as { usd: number; task: { keywords: string[] } },
  )
  const ledger = db
    .query("SELECT count(*) AS n, sum(coalesce(actual_usd, estimate_usd)) AS usd FROM spend WHERE month = '2026-11'")
    .get() as { n: number; usd: number }
  const statuses = db.query("SELECT status, count(*) AS n FROM snapshots GROUP BY status").all()
  const rowsOf = new Map(
    (
      db
        .query("SELECT n.subject, count(*) AS rows FROM spend s JOIN snapshots n ON n.id = s.snapshot_id GROUP BY n.subject")
        .all() as { subject: string; rows: number }[]
    ).map((r) => [r.subject, r.rows]),
  )
  const chargedOf = Map.groupBy(charges, (c) => c.task.keywords[0]!)

  expect(killed).toBeGreaterThan(0)
  expect(statuses).toEqual([{ status: "ok", n: 50 }])
  expect(chargedOf.size).toBe(50)
  // Per subject: a spend row for every charged call, so a row killed before its call cannot stand in for another's.
  for (const [subject, charged] of chargedOf) expect(rowsOf.get(subject) ?? 0, subject).toBeGreaterThanOrEqual(charged.length)
  expect(ledger.usd).toBeGreaterThanOrEqual(charges.reduce((sum, c) => sum + c.usd, 0) - 1e-9)
})
