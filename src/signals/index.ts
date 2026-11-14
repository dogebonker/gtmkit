import type { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { Effect } from "effect"
import { now } from "../env"
import { getProject, listProjectIds, type Project } from "../projects"
import { bucketOf, type Change, type Collector, type Metric, type Providers, weekStart } from "./collector"
import { fetchPage } from "./fetcher"
import { collectors } from "./registry"

export { collectors } from "./registry"
export { bucketOf, type Metric, type Providers } from "./collector"
export { bareDomain, dataForSEO, type DataForSEO, type Fetch } from "./dataforseo"
export { TOTAL as GSC_TOTAL } from "./collectors/gsc_performance"
export { fetchPage } from "./fetcher"
export { searchConsole, type GoogleCredentials } from "./google"

const CLAIM_TAKEOVER_MS = 10 * 60_000
const EPSILON = 1e-9
// The balance has 6 decimals: a difference below this is rounding, not money.
const RECONCILE_TOLERANCE = 1e-6
const SCHEDULED_ATTEMPTS = 3
const CONCURRENCY = 10
const CHANGES_PER_KIND = 20
const WEEK_MS = 7 * 86_400_000

const MISSING_PROVIDER: Record<keyof Providers, string> = {
  dataforseo: "no DataForSEO credentials. Run gtmkit init in a terminal",
  gsc: "no Search Console credentials. Add google.service_account or google.oauth to ~/.gtmkit/credentials, or set GOOGLE_APPLICATION_CREDENTIALS",
  web: "no page fetcher",
}

export interface Snapshot {
  id: number
  project_id: string
  kind: string
  subject: string
  captured_at: string
  payload: unknown
}

export type CollectResult =
  | { status: "estimate"; kind: string; subject: string; estimate_usd: number; fresh: boolean }
  | { status: "fresh" | "collected"; snapshot: Snapshot }
  | { status: "in_progress"; kind: string; subject: string }
  | { status: "refused"; reason: string }
  | { status: "failed"; reason: string; retryable?: boolean }
  /** A kind with `discover`, called with no subject: every discovered subject not stored in this period. */
  | { status: "set"; kind: string; dry_run: boolean; due: number; estimate_usd: number; collected: number; failed: string[] }

export interface KindDigest {
  /** Tracked subjects with an ok snapshot in their bucket current at the period's end (or now), of those tracked. */
  coverage: { collected: number; expected: number }
  /**
   * The largest changes against the latest earlier snapshot of each subject. A subject with no snapshot on either side
   * is unknown, not a change. `evidence` holds the ids of the earlier and the current snapshot.
   */
  changes: (Change & { evidence: number[] })[]
}

interface SnapshotRow {
  id: number
  project_id: string
  kind: string
  subject: string
  status: string
  captured_at: string
  payload: string | null
}

const toSnapshot = (r: SnapshotRow): Snapshot => ({
  id: r.id,
  project_id: r.project_id,
  kind: r.kind,
  subject: r.subject,
  captured_at: r.captured_at,
  payload: r.payload === null ? null : JSON.parse(r.payload),
})

const usd = (n: number) => `$${n.toFixed(4)}`

const monthOf = (at: Date) => at.toISOString().slice(0, 7)

export const createSignals = (db: Database, given: Providers) => {
  const providers: Providers = { web: fetchPage, ...given }

  const capOf = (scope: string) =>
    (db.query("SELECT usd FROM caps WHERE scope = ?").get(scope) as { usd: number } | null)?.usd ?? null

  const spent = (month: string, projectId?: string) =>
    (
      db
        .query(
          `SELECT coalesce(sum(coalesce(actual_usd, estimate_usd)), 0) AS total FROM spend
           WHERE month = ?1 AND (?2 IS NULL OR project_id = ?2)`,
        )
        .get(month, projectId ?? null) as { total: number }
    ).total

  /** Why spending `amount` more this month would break a cap, or null when it fits. */
  const capRefusal = (projectId: string, amount: number, month: string, what = "this call"): string | null => {
    const globalCap = capOf("global")
    const defaultCap = capOf("default")
    if (globalCap === null) return "no global cap is set. Run gtmkit budget"
    if (defaultCap === null) return "no default cap is set. Run gtmkit budget"
    const ownCap = capOf(projectId)
    const [capName, projectCap] = ownCap === null ? ["default cap", defaultCap] : [`project cap for ${projectId}`, ownCap]
    for (const [name, cap, used] of [
      [capName, projectCap, spent(month, projectId)],
      ["global cap", globalCap, spent(month)],
    ] as const) {
      if (used + amount > cap + EPSILON) {
        return `${name} ${usd(cap)} for ${month}: spent ${usd(used)}, ${what} needs up to ${usd(amount)}`
      }
    }
    return null
  }

  /** The snapshot key, provider request and estimate for one subject. Throws on bad input. */
  const prepare = (collector: Collector, project: Project, subject: string | undefined, at: Date) => {
    const req = collector.request(project, subject)
    const key = [
      project.id,
      collector.kind,
      req.subject,
      bucketOf(collector.schedule, at),
      // Only what is sent to the provider: JSON.stringify drops the undefined `keep`.
      createHash("sha256").update(JSON.stringify({ ...(req.params as object), keep: undefined })).digest("hex"),
    ] as const
    // Every cap check compares this number: anything else would make the comparison false and skip the cap.
    const estimate: unknown = collector.estimate(req.params)
    if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate < 0) {
      throw new Error(`${collector.kind}: the estimate is not a number >= 0, so the call is refused`)
    }
    return { ...req, key, estimate }
  }

  const findRow = (key: readonly [string, string, string, string, string]) =>
    db
      .query(
        `SELECT * FROM snapshots
         WHERE project_id = ? AND kind = ? AND subject = ? AND bucket = ? AND params_hash = ?`,
      )
      .get(...key) as SnapshotRow | null

  /**
   * Sets a spend row's reported cost, and writes `halt:<kind>` when it is above the estimate. A no-op when the row
   * already has its cost, so applying the same cost twice cannot bring back a cleared halt. A cost below the estimate
   * is kept only while the caller still holds the claim (`token`): once the claim is lost, a reading may already have
   * counted the row at its estimate, and lowering it then would show as a false excess. A higher cost always counts.
   */
  const recordCost = (c: { spend_id: number; kind: string; estimate: number; cost: number }, token: string | null = null) =>
    db.transaction(() => {
      const set = db
        .query(
          `UPDATE spend SET actual_usd = ?1 WHERE id = ?2 AND actual_usd IS NULL AND (?1 > estimate_usd OR EXISTS
             (SELECT 1 FROM snapshots n WHERE n.id = spend.snapshot_id AND n.status = 'claimed' AND n.claim_token = ?3))`,
        )
        .run(c.cost, c.spend_id, token).changes
      if (set && c.cost > c.estimate + EPSILON) {
        db.query("INSERT OR REPLACE INTO caps (scope, usd) VALUES (?, ?)").run(`halt:${c.kind}`, c.cost)
      }
    }).immediate()

  // Costs the database was too busy to take, next to the database file, applied by the next reconcile. Append-only:
  // applying is idempotent, so nothing ever truncates it and no append can race a cleanup.
  // ponytail: never shrinks. It gets a line only when a cost write fails, so it stays small.
  const costsFile = db.filename && db.filename !== ":memory:" ? `${db.filename}.costs` : null

  const insertMetric = db.query("INSERT OR REPLACE INTO metrics (project_id, kind, subject, key, date, value) VALUES (?, ?, ?, ?, ?, ?)")
  const writeMetrics = (projectId: string, kind: string, metrics: Metric[]) => {
    for (const m of metrics) insertMetric.run(projectId, kind, m.subject, m.key, m.date, m.value)
  }

  /** One provider call attempt: the write path of the design, steps 1 to 3. */
  const attempt = async (projectId: string, kind: string, params: { subject?: string }, dryRun: boolean): Promise<CollectResult> => {
    const collector = collectors.get(kind)
    if (!collector) return { status: "refused", reason: `unknown kind ${kind}` }
    const project = getProject(db, projectId)
    if (!project) return { status: "refused", reason: `unknown project ${projectId}` }
    const at = now()
    let req: ReturnType<typeof prepare>
    try {
      req = prepare(collector, project, params.subject, at)
    } catch (e) {
      return { status: "refused", reason: (e as Error).message }
    }
    const { estimate, key } = req

    if (dryRun) {
      const fresh = findRow(key)?.status === "ok"
      return { status: "estimate", kind, subject: req.subject, estimate_usd: fresh ? 0 : estimate, fresh }
    }

    const token = randomUUID()
    const month = monthOf(at)

    // Step 1: claim, check caps and record the spend at its estimate, all in one write transaction.
    const claim = db.transaction((): CollectResult | { status: "claimed"; snapshotId: number; spendId: number } => {
      const halt = db
        .query("SELECT scope FROM caps WHERE scope IN (?, 'halt:all') ORDER BY scope")
        .get(`halt:${kind}`) as { scope: string } | null
      if (halt) {
        return {
          status: "refused",
          reason: `${halt.scope} is set: the provider charged more than estimated. Fix src/signals/prices.ts, then run gtmkit budget --clear-halt`,
        }
      }
      const row = findRow(key)
      if (row?.status === "ok") return { status: "fresh", snapshot: toSnapshot(row) }
      if (row?.status === "claimed" && at.getTime() - Date.parse(row.captured_at) < CLAIM_TAKEOVER_MS) {
        return { status: "in_progress", kind, subject: req.subject }
      }
      if (!providers[collector.provider]) return { status: "refused", reason: MISSING_PROVIDER[collector.provider] }
      const refusal = capRefusal(projectId, estimate, month)
      if (refusal) return { status: "refused", reason: refusal }

      const capturedAt = at.toISOString()
      const snapshotId = row
        ? (db
            .query("UPDATE snapshots SET status = 'claimed', claim_token = ?, captured_at = ?, payload = NULL WHERE id = ?")
            .run(token, capturedAt, row.id),
          row.id)
        : (
            db
              .query(
                `INSERT INTO snapshots (project_id, kind, subject, bucket, params_hash, status, claim_token, captured_at)
                 VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?) RETURNING id`,
              )
              .get(...key, token, capturedAt) as { id: number }
          ).id
      const { attempts } = db.query("SELECT count(*) AS attempts FROM spend WHERE snapshot_id = ?").get(snapshotId) as {
        attempts: number
      }
      const spendId = Number(
        db
          .query(
            `INSERT INTO spend (snapshot_id, attempt, project_id, kind, month, estimate_usd, at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(snapshotId, attempts + 1, projectId, kind, month, estimate, capturedAt).lastInsertRowid,
      )
      return { status: "claimed", snapshotId, spendId }
    }).immediate()
    if (claim.status !== "claimed") return claim

    // Step 2: one provider call.
    const outcome = await Effect.runPromise(
      collector.fetch(req.params, providers[collector.provider]!).pipe(
        Effect.match({
          onFailure: (e) => ({ ok: false as const, reason: e.message, retryable: e.retryable ?? false, costUsd: e.costUsd }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      ),
    ).catch((defect: unknown) => ({ ok: false as const, reason: String(defect), retryable: false, costUsd: undefined }))

    // Step 3: complete, guarded by the claim token. It never throws: the provider has charged by now.
    const completedAt = now().toISOString()
    const markFailed = () => db.query("UPDATE snapshots SET status = 'failed' WHERE id = ? AND claim_token = ?").run(claim.snapshotId, token)
    const costUsd = outcome.ok ? outcome.value.costUsd : outcome.costUsd
    try {
      // The reported cost and any halt first, on their own: the metrics work below cannot roll them back.
      if (costUsd !== undefined) {
        const cost = { spend_id: claim.spendId, kind, estimate, cost: costUsd }
        try {
          // SQLite's busy handler already retries this for the 5 s busy timeout, which outlasts every writer of this
          // program (their transactions take milliseconds). A lock held longer belongs to something else.
          recordCost(cost, token)
        } catch (e) {
          // The leading newline ends a line torn by an earlier crash, so it cannot swallow this one.
          if (costsFile) appendFileSync(costsFile, `\n${JSON.stringify(cost)}\n`, { mode: 0o600 })
          throw e
        }
      }
      if (!outcome.ok) {
        markFailed()
        return { status: "failed", reason: outcome.reason, retryable: outcome.retryable }
      }
      const { payload } = outcome.value
      // Metrics are derived in the same transaction as the snapshot.
      const stored = db.transaction(() => {
        const changed = db
          .query("UPDATE snapshots SET status = 'ok', payload = ?, captured_at = ? WHERE id = ? AND claim_token = ?")
          .run(JSON.stringify(payload), completedAt, claim.snapshotId, token).changes
        if (changed) {
          const prev = db
            .query(
              `SELECT payload FROM snapshots WHERE status = 'ok' AND project_id = ? AND kind = ? AND subject = ? AND id != ?
               ORDER BY captured_at DESC, id DESC LIMIT 1`,
            )
            .get(projectId, kind, req.subject, claim.snapshotId) as { payload: string } | null
          writeMetrics(projectId, kind, collector.extract(payload, prev && JSON.parse(prev.payload)))
        }
        return changed
      }).immediate()
      if (!stored) return { status: "failed", reason: "another process took over the claim; the result was not stored" }
      return {
        status: "collected",
        snapshot: { id: claim.snapshotId, project_id: projectId, kind, subject: req.subject, captured_at: completedAt, payload },
      }
    } catch (e) {
      try {
        markFailed()
      } catch {
        // Still locked by another writer: the claim stays and is taken over after 10 minutes.
      }
      return { status: "failed", reason: `the provider was called but the result was not stored: ${(e as Error).message}` }
    }
  }

  /**
   * Interactive calls are never retried. Scheduled calls retry up to 2 times on network errors and 5xx, never
   * after a timeout, and each retry is a full new attempt with its own claim, cap check and spend row.
   */
  const collectOne = async (
    projectId: string,
    kind: string,
    params: { subject?: string },
    dryRun: boolean,
    scheduled = false,
  ): Promise<CollectResult> => {
    for (let i = 1; ; i++) {
      const r = await attempt(projectId, kind, params, dryRun)
      if (!scheduled || i === SCHEDULED_ATTEMPTS || r.status !== "failed" || !r.retryable) return r
    }
  }

  /** The subjects with no ok snapshot in this period, with their estimates. Subjects the collector rejects are left out. */
  const dueOf = (collector: Collector, project: Project, subjects: string[], at: Date) =>
    [...new Set(subjects)].flatMap((subject) => {
      try {
        const p = prepare(collector, project, subject, at)
        return findRow(p.key)?.status === "ok" ? [] : [{ subject, estimate: p.estimate }]
      } catch {
        return []
      }
    })

  /** Collects a due set, or none of it when the whole set's estimate does not fit the caps. */
  const collectDue = async (projectId: string, kind: string, due: { subject: string; estimate: number }[], at: Date, scheduled: boolean) => {
    const estimate_usd = due.reduce((sum, d) => sum + d.estimate, 0)
    const done: { estimate_usd: number; collected: number; failed: string[]; skipped?: string } = { estimate_usd, collected: 0, failed: [] }
    const refusal = capRefusal(projectId, estimate_usd, monthOf(at), `the due set of ${due.length}`)
    if (refusal) return { ...done, skipped: refusal }
    const results = await Effect.runPromise(
      Effect.forEach(
        due,
        (d) =>
          Effect.promise(() =>
            // One subject that throws fails alone: the rest of the set, and runDue's end reconcile, still run.
            collectOne(projectId, kind, { subject: d.subject }, false, scheduled).catch(
              (e: unknown): CollectResult => ({ status: "failed", reason: String(e) }),
            ),
          ),
        { concurrency: CONCURRENCY },
      ),
    )
    for (const r of results) {
      if (r.status === "collected" || r.status === "fresh") done.collected++
      else done.failed.push("reason" in r ? r.reason : r.status)
    }
    return done
  }

  const collect = async (projectId: string, kind: string, params: { subject?: string }, dryRun: boolean): Promise<CollectResult> => {
    const collector = collectors.get(kind)
    const project = getProject(db, projectId)
    if (params.subject !== undefined || !collector?.discover || !project) return collectOne(projectId, kind, params, dryRun)
    const found = await Effect.runPromise(
      collector.discover(project, providers.web!).pipe(
        Effect.match({ onFailure: (e) => ({ ok: false as const, reason: e.message }), onSuccess: (s) => ({ ok: true as const, s }) }),
      ),
    )
    if (!found.ok) return { status: "failed", reason: found.reason }
    const at = now()
    const due = dueOf(collector, project, found.s, at)
    const set = { status: "set" as const, kind, dry_run: dryRun, due: due.length }
    if (dryRun) return { ...set, estimate_usd: due.reduce((sum, d) => sum + d.estimate, 0), collected: 0, failed: [] }
    const { skipped, ...r } = await collectDue(projectId, kind, due, at, false)
    return skipped ? { status: "refused", reason: skipped } : { ...set, ...r }
  }

  /** Stored snapshots, newest first, at most `limit` of them (all when omitted). */
  const query = (projectId: string, kind: string, subject?: string, range: { from?: string; to?: string } = {}, limit?: number) =>
    (
      db
        .query(
          `SELECT * FROM snapshots WHERE status = 'ok' AND project_id = ?1 AND kind = ?2
           AND (?3 IS NULL OR subject = ?3) AND (?4 IS NULL OR captured_at >= ?4) AND (?5 IS NULL OR captured_at <= ?5)
           ORDER BY captured_at DESC, id DESC LIMIT ?6`,
        )
        .all(projectId, kind, subject ?? null, range.from ?? null, range.to ?? null, limit ?? -1) as SnapshotRow[]
    ).map(toSnapshot)

  /** Stored metric values of one kind, oldest first per subject and key. `to` (YYYY-MM-DD) keeps dates on or before it. */
  const metrics = (projectId: string, kind: string, f: { subject?: string; key?: string; to?: string } = {}) =>
    db
      .query(
        `SELECT subject, key, date, value FROM metrics WHERE project_id = ?1 AND kind = ?2
         AND (?3 IS NULL OR subject = ?3) AND (?4 IS NULL OR key = ?4) AND (?5 IS NULL OR date <= ?5)
         ORDER BY subject, key, date`,
      )
      .all(projectId, kind, f.subject ?? null, f.key ?? null, f.to ?? null) as Metric[]

  /** True when every id is a stored snapshot of the project. */
  const has = (projectId: string, snapshotIds: number[]) =>
    snapshotIds.every(
      (id) => db.query("SELECT 1 FROM snapshots WHERE id = ? AND project_id = ? AND status = 'ok'").get(id, projectId) !== null,
    )

  /** Terminal only: callers are `gtmkit init` and `gtmkit budget`. */
  const setCap = (scope: string, amount: number) => {
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`cap must be a number >= 0, got ${amount}`)
    db.query("INSERT OR REPLACE INTO caps (scope, usd) VALUES (?, ?)").run(scope, amount)
  }

  const caps = () => db.query("SELECT scope, usd FROM caps ORDER BY scope").all() as { scope: string; usd: number }[]

  /** Terminal only: `gtmkit budget --clear-halt`. */
  const clearHalts = () => db.query("DELETE FROM caps WHERE scope LIKE 'halt:%'").run().changes

  /** Recompute the metrics table from the ok snapshots, in the order they were stored. */
  const rebuildMetrics = () =>
    db.transaction(() => {
      db.run("DELETE FROM metrics")
      const prev = new Map<string, unknown>()
      const rows = db
        .query("SELECT project_id, kind, subject, payload FROM snapshots WHERE status = 'ok' ORDER BY captured_at, id")
        .iterate() as IterableIterator<{ project_id: string; kind: string; subject: string; payload: string }>
      let n = 0
      for (const r of rows) {
        const collector = collectors.get(r.kind)
        if (!collector) continue
        const id = JSON.stringify([r.project_id, r.kind, r.subject])
        const payload = JSON.parse(r.payload) as unknown
        writeMetrics(r.project_id, r.kind, collector.extract(payload, prev.get(id) ?? null))
        prev.set(id, payload)
        n++
      }
      return n
    }).immediate()

  /** The ledger total: every spend row, or with `settledOnly` the rows of calls no longer in flight. */
  const ledgerTotal = (settledOnly: boolean) =>
    (
      db
        .query(
          `SELECT coalesce(sum(coalesce(s.actual_usd, s.estimate_usd)), 0) AS total
           FROM spend s LEFT JOIN snapshots n ON n.id = s.snapshot_id
           WHERE ?1 = 0 OR n.id IS NULL OR n.status != 'claimed'`,
        )
        .get(settledOnly ? 1 : 0) as { total: number }
    ).total

  /**
   * Compare the DataForSEO balance drop since the last reading with the ledger's growth over the same time.
   * Any excess becomes a global adjustment row and `halt:all`. A manual top-up between readings can hide an excess.
   *
   * The growth counts every spend row, in flight or not, read after the balance: every call charged by then has a
   * row. The figure stored for the next reading counts settled rows only, read before the balance: each was charged
   * by then. So an in-flight or stale claim never shows as an excess. Masking is bounded by the estimates of calls in
   * flight.
   */
  const reconcile = async (phase: "start" | "end") => {
    // A torn or malformed line is skipped and counted in the run's result.
    let badCostLines = 0
    if (costsFile && existsSync(costsFile)) {
      for (const line of readFileSync(costsFile, "utf8").split("\n").filter(Boolean)) {
        let c: { spend_id: number; kind: string; estimate: number; cost: number }
        try {
          c = JSON.parse(line)
        } catch {
          badCostLines++
          continue
        }
        if ([c.spend_id, c.estimate, c.cost].every((n) => typeof n === "number") && typeof c.kind === "string") recordCost(c)
        else badCostLines++
      }
    }
    // A claim older than the takeover window belongs to a call that ended without completing: it is settled at its
    // estimate. Left claimed, its estimate would count in every reading's growth while the balance dropped once.
    // Clearing the token discards a late completion of that call, so the estimate already counted stays.
    db.query("UPDATE snapshots SET status = 'failed', claim_token = NULL WHERE status = 'claimed' AND captured_at < ?").run(
      new Date(now().getTime() - CLAIM_TAKEOVER_MS).toISOString(),
    )
    const settledBefore = ledgerTotal(true)
    const { dataforseo } = providers
    const balance = dataforseo
      ? await Effect.runPromise(dataforseo.balance().pipe(Effect.match({ onFailure: () => null, onSuccess: (b) => b })))
      : null
    return db.transaction(() => {
      const at = now()
      const ledger = ledgerTotal(false)
      let settled = settledBefore
      let adjustment = 0
      const prev = db
        .query("SELECT balance_usd, ledger_usd FROM runs WHERE balance_usd IS NOT NULL ORDER BY id DESC LIMIT 1")
        .get() as { balance_usd: number; ledger_usd: number } | null
      if (balance !== null && prev) {
        const excess = prev.balance_usd - balance - (ledger - prev.ledger_usd)
        if (excess > RECONCILE_TOLERANCE) {
          db.query(
            `INSERT INTO spend (snapshot_id, attempt, project_id, kind, month, estimate_usd, actual_usd, at)
             VALUES (NULL, 1, NULL, 'adjustment', ?, ?, ?, ?)`,
          ).run(monthOf(at), excess, excess, at.toISOString())
          db.query("INSERT OR REPLACE INTO caps (scope, usd) VALUES ('halt:all', ?)").run(excess)
          settled += excess
          adjustment = excess
        }
      }
      db.query("INSERT INTO runs (at, phase, balance_usd, ledger_usd) VALUES (?, ?, ?, ?)").run(
        at.toISOString(),
        phase,
        balance,
        settled,
      )
      return { balance_usd: balance, adjustment_usd: adjustment, bad_cost_lines: badCostLines }
    }).immediate()
  }

  /**
   * Collect every due subject of every weekly kind. A kind's whole due set is estimated first, and the kind is
   * skipped for the period when the set does not fit the caps.
   */
  const runDue = async () => {
    const start = await reconcile("start")
    const at = now()
    const kinds: ({ project_id: string; kind: string; due: number } & Awaited<ReturnType<typeof collectDue>>)[] = []
    for (const projectId of listProjectIds(db)) {
      const project = getProject(db, projectId)!
      for (const collector of collectors.values()) {
        if (collector.schedule !== "weekly") continue
        const due = dueOf(collector, project, collector.subjects(project), at)
        if (due.length === 0) continue
        kinds.push({ project_id: projectId, kind: collector.kind, due: due.length, ...(await collectDue(projectId, collector.kind, due, at, true)) })
      }
    }
    const end = await reconcile("end")
    return { start, end, kinds }
  }

  /** Per kind, the tracked subjects with an ok snapshot in the bucket current at `at`, of the subjects tracked. */
  const coverage = (project: Project, at: Date) => {
    const stored = db.query("SELECT DISTINCT subject FROM snapshots WHERE status = 'ok' AND project_id = ? AND kind = ? AND bucket = ?")
    return Object.fromEntries(
      [...collectors.values()].map((c) => {
        const have = new Set((stored.all(project.id, c.kind, bucketOf(c.schedule, at)) as { subject: string }[]).map((r) => r.subject))
        const expected = c.subjects(project)
        return [c.kind, { collected: expected.filter((s) => have.has(s)).length, expected: expected.length }]
      }),
    )
  }

  /** Changes in an ISO week (default: the current one) against the latest earlier snapshot of each subject. */
  const digest = (projectId: string, period?: string) => {
    const project = getProject(db, projectId)
    if (!project) throw new Error(`unknown project ${projectId}`)
    const week = period ?? bucketOf("weekly", now())
    const from = weekStart(week)
    const to = new Date(from.getTime() + WEEK_MS)
    const latest = db.query(
      `SELECT id, subject, payload, max(captured_at) AS captured_at FROM snapshots
       WHERE status = 'ok' AND project_id = ?1 AND kind = ?2 AND captured_at >= ?3 AND captured_at < ?4
       GROUP BY subject`,
    )
    // Coverage as of the period's last moment, or now for the current period.
    const covered = coverage(project, new Date(Math.min(now().getTime(), to.getTime() - 1)))
    const kinds: Record<string, KindDigest> = {}
    for (const collector of collectors.values()) {
      type Row = { id: number; subject: string; payload: string }
      const cur = latest.all(projectId, collector.kind, from.toISOString(), to.toISOString()) as Row[]
      const before = new Map(
        (latest.all(projectId, collector.kind, "", from.toISOString()) as Row[]).map((r) => [r.subject, r]),
      )
      kinds[collector.kind] = {
        coverage: covered[collector.kind]!,
        changes: cur
          .flatMap((r) => {
            const prev = before.get(r.subject)
            return prev === undefined
              ? []
              : collector.diff(JSON.parse(prev.payload), JSON.parse(r.payload)).map((c) => ({ ...c, evidence: [prev.id, r.id] }))
          })
          .sort((a, b) => b.magnitude - a.magnitude)
          .slice(0, CHANGES_PER_KIND),
      }
    }
    return { project_id: projectId, period: week, from: from.toISOString(), to: to.toISOString(), kinds }
  }

  /** Last tick, halts, this month's spend against the caps, and this week's coverage per project and kind. */
  const status = () => {
    const month = monthOf(now())
    const lastTick = db.query("SELECT at FROM runs WHERE phase = 'end' ORDER BY id DESC LIMIT 1").get() as { at: string } | null
    return {
      last_tick: lastTick?.at ?? null,
      month,
      halts: caps()
        .filter((c) => c.scope.startsWith("halt:"))
        .map((c) => c.scope),
      global: { spent_usd: spent(month), cap_usd: capOf("global") },
      projects: listProjectIds(db).map((id) => ({
        id,
        spent_usd: spent(month, id),
        cap_usd: capOf(id) ?? capOf("default"),
        coverage: coverage(getProject(db, id)!, now()),
      })),
    }
  }

  return { collect, query, metrics, has, setCap, caps, clearHalts, rebuildMetrics, runDue, digest, status }
}

export type Signals = ReturnType<typeof createSignals>
