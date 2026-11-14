import { Effect, Schema } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"
import { bareDomain, maybe } from "../dataforseo"
import { labsEstimate } from "../prices"

// docs.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live/
const PATH = "/v3/dataforseo_labs/google/ranked_keywords/live"
const LIMIT = 100

interface Params {
  target: string
  location_name: string
  language_name: string
  limit: number
  order_by: string[]
}

interface Ranked {
  keyword: string
  search_volume: number | null
  rank: number | null
  url: string | null
}

interface Payload {
  date: string
  target: string
  total_count: number
  items: Ranked[]
}

const Result = Schema.Array(
  Schema.Struct({
    total_count: maybe(Schema.Number),
    items: maybe(
      Schema.Array(
        Schema.Struct({
          keyword_data: Schema.Struct({
            keyword: Schema.String,
            keyword_info: maybe(Schema.Struct({ search_volume: maybe(Schema.Number) })),
          }),
          ranked_serp_element: maybe(
            Schema.Struct({
              serp_item: maybe(Schema.Struct({ rank_absolute: maybe(Schema.Number), url: maybe(Schema.String) })),
            }),
          ),
        }),
      ),
    ),
  }),
)
const decode = Schema.decodeUnknownEffect(Result)

const collector: Collector<Params, Payload, "dataforseo"> = {
  kind: "competitor_keywords",
  schedule: { freshnessDays: 30 },
  provider: "dataforseo",
  subjects: (project) => project.competitors.map(bareDomain),
  request: (project, subject) => {
    if (!subject) throw new Error("competitor_keywords needs a competitor domain as subject")
    const target = bareDomain(subject)
    return {
      subject: target,
      params: {
        target,
        location_name: project.location,
        language_name: project.language,
        limit: LIMIT,
        // Keep the highest-volume rows when the competitor ranks for more than LIMIT keywords.
        order_by: ["keyword_data.keyword_info.search_volume,desc"],
      },
    }
  },
  estimate: (p) => labsEstimate(p.limit),
  fetch: (p, dataforseo) =>
    dataforseo(PATH, { ...p }, decode).pipe(
      Effect.map(({ result: r, costUsd }) => ({
        costUsd,
        payload: {
          date: now().toISOString().slice(0, 10),
          target: p.target,
          total_count: r[0]?.total_count ?? 0,
          items: (r[0]?.items ?? []).slice(0, LIMIT).map((i) => ({
            keyword: i.keyword_data.keyword,
            search_volume: i.keyword_data.keyword_info?.search_volume ?? null,
            rank: i.ranked_serp_element?.serp_item?.rank_absolute ?? null,
            url: i.ranked_serp_element?.serp_item?.url ?? null,
          })),
        },
      })),
    ),
  extract: (payload) => [
    { subject: payload.target, key: "ranked_keywords", date: payload.date, value: payload.total_count },
  ],
  diff: (prev, cur) => {
    const seen = new Set(prev?.items.map((i) => i.keyword))
    const changes = cur.items
      .filter((i) => !seen.has(i.keyword))
      .map((i) => ({
        subject: i.keyword,
        summary: `${cur.target} now ranks ${i.rank ?? "?"} for "${i.keyword}" (volume ${i.search_volume ?? "unknown"})`,
        magnitude: i.search_volume ?? 0,
      }))
    const delta = cur.total_count - (prev?.total_count ?? 0)
    if (delta !== 0) {
      changes.push({
        subject: cur.target,
        summary: `${cur.target} ranked keywords ${prev?.total_count ?? 0} -> ${cur.total_count}`,
        magnitude: Math.abs(delta),
      })
    }
    return changes
  },
}

export default collector
