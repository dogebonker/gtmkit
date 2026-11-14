import type { ListedAction, Target } from "../src/actions"
import { collectors } from "../src/signals"

export interface RunResult {
  /** Every action of the project after the run. */
  actions: ListedAction[]
  /** Ids of the actions the fixture held before the run. */
  before: Set<number>
  /** True when every id is a stored snapshot of the project. */
  validEvidence: (ids: number[]) => boolean
  briefSaved: boolean
  /** False when a correct run may propose nothing. */
  expectActions: boolean
}

const same = (a: Target, b: Target) => a.kind === b.kind && a.subject === b.subject && a.key === b.key

/** The failures of one brief run, empty when it passes. */
export const grade = (r: RunResult): string[] => {
  const failures: string[] = []
  if (!r.briefSaved) failures.push("no brief stored for the period")
  const fresh = r.actions.filter((a) => !r.before.has(a.id))
  const dropped = r.actions.filter((a) => r.before.has(a.id) && a.status === "dropped")
  if (r.expectActions && fresh.length === 0) failures.push("no action proposed")
  for (const a of fresh) {
    if (a.evidence.length === 0 || !r.validEvidence(a.evidence)) failures.push(`action ${a.id}: evidence ${JSON.stringify(a.evidence)} is not stored`)
    const { kind, subject, key } = a.target
    if (!collectors.has(kind) || !subject.trim() || !key.trim()) failures.push(`action ${a.id}: no target metric`)
    if (dropped.some((d) => same(d.target, a.target))) failures.push(`action ${a.id}: repeats the dropped target ${kind} / ${subject} / ${key}`)
  }
  return failures
}
