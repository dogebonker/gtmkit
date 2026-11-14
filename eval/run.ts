// bun run eval [case] [runs]: each brief case, 3 runs by default, with the real headless command (claude -p on your
// subscription). Every run gets a fresh fixture in its own temporary GTMKIT_HOME, where its transcript stays.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createActions } from "../src/actions"
import { openDb } from "../src/db"
import { dbPath } from "../src/env"
import { runBrief } from "../src/edge/cli/headless"
import { createSignals } from "../src/signals"
import { buildFixture, cases } from "./fixture"
import { grade } from "./grader"

const [only, runsArg] = process.argv.slice(2)
const runs = Number(runsArg ?? 3)
const selected = cases.filter((c) => !only || c.name === only)
if (selected.length === 0) throw new Error(`unknown case ${only}. Cases: ${cases.map((c) => c.name).join(", ")}`)

let failed = 0
for (const c of selected) {
  for (let i = 1; i <= runs; i++) {
    process.env.GTMKIT_HOME = mkdtempSync(join(tmpdir(), `gtmkit-eval-${c.name}-`))
    const f = await buildFixture(c)
    const run = await runBrief(f.projectId)
    const db = openDb(dbPath())
    const signals = createSignals(db, { dataforseo: null })
    const actions = createActions(db, signals)
    const failures = grade({
      actions: actions.list(f.projectId),
      before: f.before,
      validEvidence: (ids) => signals.has(f.projectId, ids),
      briefSaved: actions.latestBrief(f.projectId)?.period === f.period,
      expectActions: c.expectActions ?? true,
    })
    if (failures.length) failed++
    console.log(`${failures.length ? "FAIL" : "pass"} ${c.name} #${i} (exit ${run.exit_code}) ${run.transcript}`)
    for (const f of failures) console.log(`  ${f}`)
    db.close()
  }
}
console.log(`${selected.length * runs - failed} of ${selected.length * runs} runs passed`)
process.exit(failed ? 1 : 0)
