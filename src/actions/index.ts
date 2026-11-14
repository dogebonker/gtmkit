import type { Database } from "bun:sqlite"
import { now } from "../env"
import { collectors, type Signals } from "../signals"

const DELTA_AFTER_MS = 28 * 86_400_000
const PERIOD = /^\d{4}-W\d{2}$/

export type Status = "proposed" | "accepted" | "done" | "dropped"

const NEXT: Record<Status, Status[]> = { proposed: ["accepted", "dropped"], accepted: ["done", "dropped"], done: [], dropped: [] }

/** A stored metric: `kind`, `subject` and `key` as in the metrics table. */
export interface Target {
  kind: string
  subject: string
  key: string
}

export interface ActionInput {
  title: string
  rationale: string
  evidence: number[]
  target: Target
}

export interface Action extends ActionInput {
  id: number
  project_id: string
  status: Status
  baseline: number | null
  done_at: string | null
}

export interface ListedAction extends Action {
  /** Done actions only: null until 4 weeks have passed since done_at. */
  delta?: { note: string; baseline: number | null; current: number | null; delta: number | null } | null
  /** Done actions only: another done action has the same target, so neither delta is its alone. */
  shared_target?: boolean
}

interface ActionRow {
  id: number
  project_id: string
  title: string
  rationale: string
  evidence: string
  target_kind: string
  target_subject: string
  target_key: string
  status: Status
  baseline: number | null
  done_at: string | null
}

const toAction = ({ evidence, target_kind, target_subject, target_key, ...r }: ActionRow): Action => ({
  ...r,
  evidence: JSON.parse(evidence),
  target: { kind: target_kind, subject: target_subject, key: target_key },
})

const sameTarget = (a: Target, b: Target) => a.kind === b.kind && a.subject === b.subject && a.key === b.key

export const createActions = (db: Database, signals: Signals) => {
  /** The target metric's latest value dated on or before `day` (YYYY-MM-DD; any date when omitted). */
  const valueOf = (projectId: string, t: Target, day?: string): number | null =>
    signals.metrics(projectId, t.kind, { subject: t.subject, key: t.key, to: day }).at(-1)?.value ?? null

  const get = (id: number) => {
    const row = db.query("SELECT * FROM actions WHERE id = ?").get(id) as ActionRow | null
    return row && toAction(row)
  }

  /** Rejected unless every evidence id is a stored snapshot of the project and the target metric is named. */
  const propose = (projectId: string, a: ActionInput): Action => {
    if (!a.title.trim()) throw new Error("refused: an action needs a title")
    if (a.evidence.length === 0) throw new Error("refused: an action needs at least one evidence snapshot id")
    const unknown = a.evidence.filter((id) => !signals.has(projectId, [id]))
    if (unknown.length) throw new Error(`refused: evidence ${unknown.join(", ")} is not a stored snapshot of project ${projectId}`)
    const { kind, subject, key } = a.target
    if (!collectors.has(kind) || !subject.trim() || !key.trim()) {
      throw new Error(`refused: name the target metric: kind (one of ${[...collectors.keys()].join(", ")}), subject and key`)
    }
    const { id } = db
      .query(
        `INSERT INTO actions (project_id, title, rationale, evidence, target_kind, target_subject, target_key, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed') RETURNING id`,
      )
      .get(projectId, a.title, a.rationale, JSON.stringify(a.evidence), kind, subject, key) as { id: number }
    return get(id)!
  }

  /** proposed -> accepted or dropped, accepted -> done or dropped. Done records done_at and the baseline. */
  const update = (projectId: string, id: number, status: Status): Action =>
    db.transaction(() => {
      const a = get(id)
      if (!a || a.project_id !== projectId) throw new Error(`unknown action ${id} in project ${projectId}`)
      if (!NEXT[a.status].includes(status)) {
        throw new Error(`refused: ${a.status} -> ${status}. From ${a.status}: ${NEXT[a.status].join(", ") || "none"}`)
      }
      if (status === "done") {
        const doneAt = now().toISOString()
        db.query("UPDATE actions SET status = ?, done_at = ?, baseline = ? WHERE id = ?").run(
          status,
          doneAt,
          valueOf(projectId, a.target, doneAt.slice(0, 10)),
          id,
        )
      } else {
        db.query("UPDATE actions SET status = ? WHERE id = ?").run(status, id)
      }
      return get(id)!
    }).immediate()

  /** Every action of the project. Done actions carry their delta once 4 weeks have passed since done_at. */
  const list = (projectId: string): ListedAction[] => {
    const all = (db.query("SELECT * FROM actions WHERE project_id = ? ORDER BY id").all(projectId) as ActionRow[]).map(toAction)
    const done = all.filter((a) => a.status === "done")
    const at = now().getTime()
    return all.map((a) => {
      if (a.status !== "done") return a
      const shared_target = done.some((b) => b.id !== a.id && sameTarget(a.target, b.target))
      if (at - Date.parse(a.done_at!) < DELTA_AFTER_MS) return { ...a, delta: null, shared_target }
      const current = valueOf(projectId, a.target)
      return {
        ...a,
        shared_target,
        delta: {
          note: "a delta, not proof: other changes can explain it",
          baseline: a.baseline,
          current,
          delta: a.baseline === null || current === null ? null : current - a.baseline,
        },
      }
    })
  }

  /** Accepted and done over accepted, done and dropped. Null when nothing has been decided. */
  const acceptance = (projectId: string) => {
    const r = db
      .query(
        `SELECT coalesce(sum(status IN ('accepted', 'done')), 0) AS accepted, coalesce(sum(status != 'proposed'), 0) AS decided
         FROM actions WHERE project_id = ?`,
      )
      .get(projectId) as { accepted: number; decided: number }
    return { ...r, rate: r.decided ? r.accepted / r.decided : null }
  }

  const saveBrief = (projectId: string, period: string, markdown: string) => {
    if (!PERIOD.test(period)) throw new Error(`period must be an ISO week like 2026-W46, got ${period}`)
    if (!markdown.trim()) throw new Error("refused: the brief is empty")
    const created_at = now().toISOString()
    db.query("INSERT INTO briefs (project_id, period, markdown, created_at) VALUES (?, ?, ?, ?)").run(projectId, period, markdown, created_at)
    return { project_id: projectId, period, created_at }
  }

  const latestBrief = (projectId: string) =>
    db
      .query(
        "SELECT project_id, period, markdown, created_at FROM briefs WHERE project_id = ? ORDER BY period DESC, created_at DESC, id DESC LIMIT 1",
      )
      .get(projectId) as { project_id: string; period: string; markdown: string; created_at: string } | null

  return { propose, update, list, acceptance, saveBrief, latestBrief }
}

export type Actions = ReturnType<typeof createActions>
