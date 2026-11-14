import { Effect } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"
import { bareDomain } from "../dataforseo"

// developers.google.com/webmaster-tools/v1/searchanalytics/query
// Rows come sorted by clicks, descending. With no dimensions the API returns one row of totals.
// Free. Data lags 2 to 3 days, so a run fetches the 7 days ending 3 days before it.
const ROW_LIMIT = 1000
const DAY_MS = 86_400_000
/** The metric subject of the site total. Search Console reports queries in lower case, so it cannot be a query. */
export const TOTAL = "TOTAL"

interface Params {
  domain: string
  /** `sc-domain:example.com`, or the URL-prefix property when the profile domain is a URL. */
  site_url: string
}

interface QueryRow {
  query: string
  clicks: number
  impressions: number
  position: number
}

interface Payload {
  date: string
  start: string
  domain: string
  total: { clicks: number; impressions: number; position: number } | null
  items: QueryRow[]
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const pos = (n: number) => n.toFixed(1)

const collector: Collector<Params, Payload, "gsc"> = {
  kind: "gsc_performance",
  schedule: "weekly",
  provider: "gsc",
  subjects: (project) => [bareDomain(project.domain)],
  request: (project) => {
    const domain = bareDomain(project.domain)
    const site_url = /^https?:\/\//i.test(project.domain.trim())
      ? project.domain.trim().replace(/\/?$/, "/")
      : `sc-domain:${domain}`
    return { subject: domain, params: { domain, site_url } }
  },
  estimate: () => 0,
  fetch: (p, gsc) => {
    const endMs = now().getTime() - 3 * DAY_MS
    const window = { startDate: day(endMs - 6 * DAY_MS), endDate: day(endMs), type: "web" }
    return Effect.all([
      gsc(p.site_url, window),
      gsc(p.site_url, { ...window, dimensions: ["query"], rowLimit: ROW_LIMIT }),
    ]).pipe(
      Effect.map(([totals, rows]) => ({
        costUsd: 0,
        payload: {
          date: window.endDate,
          start: window.startDate,
          domain: p.domain,
          total: totals[0]
            ? { clicks: totals[0].clicks, impressions: totals[0].impressions, position: totals[0].position }
            : null,
          items: rows.slice(0, ROW_LIMIT).map((r) => ({
            query: r.keys[0] ?? "",
            clicks: r.clicks,
            impressions: r.impressions,
            position: r.position,
          })),
        },
      })),
    )
  },
  extract: (payload) =>
    [...(payload.total ? [{ ...payload.total, query: TOTAL }] : []), ...payload.items].flatMap((row) =>
      (["clicks", "impressions", "position"] as const).map((key) => ({
        subject: row.query,
        key,
        date: payload.date,
        value: row[key],
      })),
    ),
  diff: (prev, cur) => {
    if (!prev) return []
    const changes = []
    const a = prev.total
    const b = cur.total
    if (a && b && (a.clicks !== b.clicks || a.impressions !== b.impressions)) {
      changes.push({
        subject: TOTAL,
        summary: `${cur.domain} total: clicks ${a.clicks} -> ${b.clicks}, impressions ${a.impressions} -> ${b.impressions}, position ${pos(a.position)} -> ${pos(b.position)}`,
        magnitude: Math.abs(b.clicks - a.clicks),
      })
    }
    const before = new Map(prev.items.map((i) => [i.query, i]))
    for (const i of cur.items) {
      const old = before.get(i.query)
      before.delete(i.query)
      if (!old) {
        changes.push({
          subject: i.query,
          summary: `new query "${i.query}": ${i.clicks} clicks, position ${pos(i.position)}`,
          magnitude: i.clicks,
        })
        continue
      }
      const dPos = Math.abs(i.position - old.position)
      if (i.clicks === old.clicks && dPos < 1) continue
      changes.push({
        subject: i.query,
        summary: `query "${i.query}": clicks ${old.clicks} -> ${i.clicks}, position ${pos(old.position)} -> ${pos(i.position)}`,
        magnitude: Math.max(Math.abs(i.clicks - old.clicks), dPos),
      })
    }
    for (const old of before.values()) {
      changes.push({
        subject: old.query,
        summary: `query "${old.query}" left the top ${ROW_LIMIT} (had ${old.clicks} clicks)`,
        magnitude: old.clicks,
      })
    }
    return changes
  },
}

export default collector
