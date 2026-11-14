import { Effect, Schema } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"
import { bareDomain, maybe } from "../dataforseo"
import { PRICES } from "../prices"

// docs.dataforseo.com/v3/backlinks/summary/live/: target is a domain without scheme or www., result[0] is one summary.
// Billed per task plus per row; the summary is one row. internal_list_limit keeps its nested lists short.
const PATH = "/v3/backlinks/summary/live"

interface Params {
  target: string
  internal_list_limit: number
}

interface Summary {
  backlinks: number | null
  referring_domains: number | null
  referring_main_domains: number | null
  rank: number | null
  broken_backlinks: number | null
}

interface Payload {
  date: string
  target: string
  items: Summary[]
}

const Result = Schema.Array(
  Schema.Struct({
    backlinks: maybe(Schema.Number),
    referring_domains: maybe(Schema.Number),
    referring_main_domains: maybe(Schema.Number),
    rank: maybe(Schema.Number),
    broken_backlinks: maybe(Schema.Number),
  }),
)
const decode = Schema.decodeUnknownEffect(Result)

const KEYS = ["referring_domains", "backlinks"] as const

const collector: Collector<Params, Payload, "dataforseo"> = {
  kind: "backlinks_summary",
  schedule: { freshnessDays: 30 },
  provider: "dataforseo",
  subjects: (project) => [...new Set([project.domain, ...project.competitors].map(bareDomain))],
  request: (project, subject) => {
    const target = bareDomain(subject ?? project.domain)
    if (!target) throw new Error("backlinks_summary needs a domain as subject")
    return { subject: target, params: { target, internal_list_limit: 1 } }
  },
  estimate: () => PRICES.backlinksTask + PRICES.backlinksRow,
  fetch: (p, dataforseo) =>
    dataforseo(PATH, { ...p }, decode).pipe(
      Effect.map(({ result: r, costUsd }) => ({
        costUsd,
        payload: {
          date: now().toISOString().slice(0, 10),
          target: p.target,
          items: r.slice(0, 1).map((s) => ({
            backlinks: s.backlinks ?? null,
            referring_domains: s.referring_domains ?? null,
            referring_main_domains: s.referring_main_domains ?? null,
            rank: s.rank ?? null,
            broken_backlinks: s.broken_backlinks ?? null,
          })),
        },
      })),
    ),
  extract: (payload) =>
    KEYS.flatMap((key) => {
      const value = payload.items[0]?.[key] ?? null
      return value === null ? [] : [{ subject: payload.target, key, date: payload.date, value }]
    }),
  diff: (prev, cur) => {
    const a = prev?.items[0]
    const b = cur.items[0]
    if (!a || !b) return []
    // A count missing on either side is unknown, not a change.
    const changed = KEYS.filter((k) => a[k] !== null && b[k] !== null && a[k] !== b[k])
    if (changed.length === 0) return []
    return [
      {
        subject: cur.target,
        summary: `${cur.target}: ${changed.map((k) => `${k === "referring_domains" ? "referring domains" : k} ${a[k]} -> ${b[k]}`).join(", ")}`,
        magnitude: Math.max(...changed.map((k) => Math.abs(b[k]! - a[k]!))),
      },
    ]
  },
}

export default collector
