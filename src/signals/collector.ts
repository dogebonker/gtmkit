import type { Effect } from "effect"
import type { Project } from "../projects"
import type { DataForSEO, ProviderError } from "./dataforseo"
import type { FetchPage } from "./fetcher"
import type { SearchConsole } from "./google"

export interface Metric {
  subject: string
  key: string
  date: string
  value: number
}

export interface Change {
  subject: string
  summary: string
  magnitude: number
  /** page_watch only, always set there: every line added and removed, each cut at 300 characters. Untrusted page text. */
  added?: string[]
  removed?: string[]
}

export interface Providers {
  /** null when no credentials are configured. */
  dataforseo: DataForSEO | null
  /** Search Console. Absent or null when no Google credentials are configured. */
  gsc?: SearchConsole | null
  /** The guarded page fetcher. Defaults to the real one. */
  web?: FetchPage
}

export type Schedule = "weekly" | { freshnessDays: number }

/**
 * One file in ./collectors per kind, default-exported.
 * Rows that came from the provider go in `payload.items`: the MCP adapter returns them as untrusted text.
 */
export interface Collector<P = unknown, Payload = unknown, N extends keyof Providers = keyof Providers> {
  kind: string
  schedule: Schedule
  /** The provider `fetch` receives. A collection is refused when it is not configured. */
  provider: N
  /** The project's tracked snapshot subjects: what `runDue` collects and `digest` counts as expected. */
  subjects(project: Project): string[]
  /**
   * Optional. When a caller names no subject, the subjects to collect, read from a free page fetch (site_audit reads
   * the sitemap). Each one is then collected as its own snapshot, after the whole set's estimate fits the caps.
   */
  discover?(project: Project, web: FetchPage): Effect.Effect<string[], ProviderError>
  /**
   * Turns the caller's subject into the snapshot subject and the provider request. Throws on bad input. `params.keep`,
   * when present, holds data `fetch` stores but does not send: it is left out of the snapshot key, so editing it does
   * not buy the subject again in the same period.
   */
  request(project: Project, subject: string | undefined): { subject: string; params: P }
  /** Upper bound in USD. */
  estimate(params: P): number
  fetch(params: P, provider: NonNullable<Providers[N]>): Effect.Effect<{ payload: Payload; costUsd?: number }, ProviderError>
  /** `prev` is the subject's previous stored payload, for metrics that measure change. */
  extract(payload: Payload, prev: Payload | null): Metric[]
  diff(prev: Payload | null, cur: Payload): Change[]
}

const DAY_MS = 86_400_000

/** UTC slot a snapshot belongs to: ISO week for weekly kinds, floor(unix_day / freshnessDays) otherwise. */
export const bucketOf = (schedule: Schedule, at: Date): string => {
  if (schedule !== "weekly") return String(Math.floor(at.getTime() / DAY_MS / schedule.freshnessDays))
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)) // Thursday of this ISO week
  const week = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/** Monday 00:00 UTC of an ISO week such as `2026-W46`. A week the year does not have (W00, W53 of most years) throws. */
export const weekStart = (week: string): Date => {
  const m = /^(\d{4})-W(\d{2})$/.exec(week)
  const fail = () => new Error(`period must be an ISO week like 2026-W46, got ${week}`)
  if (!m) throw fail()
  const jan4 = Date.UTC(Number(m[1]), 0, 4)
  const monday1 = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * DAY_MS
  const start = new Date(monday1 + (Number(m[2]) - 1) * 7 * DAY_MS)
  if (bucketOf("weekly", start) !== week) throw fail()
  return start
}
