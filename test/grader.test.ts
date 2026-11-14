import { describe, expect, test } from "vite-plus/test"
import { grade, type RunResult } from "../eval/grader"
import type { ListedAction } from "../src/actions"

const serp = { kind: "serp_top30", subject: "crm for freelancers", key: "position:example.com" }
const clicks = { kind: "gsc_performance", subject: "simple crm", key: "clicks" }

const action = (id: number, over: Partial<ListedAction> = {}): ListedAction => ({
  id,
  project_id: "p",
  title: "t",
  rationale: "r",
  evidence: [1, 2],
  target: clicks,
  status: "proposed",
  baseline: null,
  done_at: null,
  ...over,
})

// The fixture held action 1, dropped, on the serp target. Snapshots 1 to 10 are stored.
const run = (fresh: ListedAction[], over: Partial<RunResult> = {}): RunResult => ({
  actions: [action(1, { status: "dropped", target: serp }), ...fresh],
  before: new Set([1]),
  validEvidence: (ids) => ids.every((id) => id >= 1 && id <= 10),
  briefSaved: true,
  expectActions: true,
  ...over,
})

describe("AC9: the brief grader", () => {
  test("passes a run whose actions cite stored evidence, name a target and avoid dropped targets", () => {
    expect(grade(run([action(2), action(3, { target: { ...serp, subject: "simple crm" } })]))).toEqual([])
    expect(grade(run([], { expectActions: false }))).toEqual([])
  })

  test("fails invalid evidence, a missing target, a repeated dropped target, no brief and no actions", () => {
    expect(grade(run([action(2, { evidence: [999] })]))).toEqual(["action 2: evidence [999] is not stored"])
    expect(grade(run([action(2, { evidence: [] })]))).toEqual(["action 2: evidence [] is not stored"])
    expect(grade(run([action(2, { target: { kind: "serp_top30", subject: "x", key: "" } })]))).toEqual(["action 2: no target metric"])
    expect(grade(run([action(2, { target: { kind: "made_up", subject: "x", key: "y" } })]))).toEqual(["action 2: no target metric"])
    expect(grade(run([action(2, { target: serp })]))).toEqual([
      "action 2: repeats the dropped target serp_top30 / crm for freelancers / position:example.com",
    ])
    expect(grade(run([action(2)], { briefSaved: false }))).toEqual(["no brief stored for the period"])
    expect(grade(run([]))).toEqual(["no action proposed"])
  })

  test("only actions made in the run are graded, and only targets dropped before it are off limits", () => {
    const stale = action(4, { evidence: [999] }) // in the fixture already
    expect(grade(run([action(2)], { actions: [stale, action(2)], before: new Set([4]) }))).toEqual([])
    // A target the run proposed and that is still proposed is not a dropped target.
    expect(grade(run([action(2, { target: clicks }), action(3, { target: clicks })]))).toEqual([])
  })
})
