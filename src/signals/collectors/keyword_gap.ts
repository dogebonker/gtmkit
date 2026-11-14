import { Effect, Schema } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"
import { bareDomain, maybe } from "../dataforseo"
import { labsEstimate } from "../prices"

// docs.dataforseo.com/v3/dataforseo_labs/google/domain_intersection/live/
// intersections: false returns keywords where target1 ranks and target2 does not.
const PATH = "/v3/dataforseo_labs/google/domain_intersection/live"
const LIMIT = 100

interface Params {
  target1: string
  target2: string
  intersections: false
  location_name: string
  language_name: string
  limit: number
  order_by: string[]
}

interface Gap {
  keyword: string
  search_volume: number | null
  difficulty: number | null
  intent: string | null
  competitor_rank: number | null
  competitor_url: string | null
}

interface Payload {
  date: string
  target: string
  total_count: number
  items: Gap[]
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
            keyword_properties: maybe(Schema.Struct({ keyword_difficulty: maybe(Schema.Number) })),
            search_intent_info: maybe(Schema.Struct({ main_intent: maybe(Schema.String) })),
          }),
          first_domain_serp_element: maybe(
            Schema.Struct({ rank_absolute: maybe(Schema.Number), url: maybe(Schema.String) }),
          ),
        }),
      ),
    ),
  }),
)
const decode = Schema.decodeUnknownEffect(Result)

const collector: Collector<Params, Payload, "dataforseo"> = {
  kind: "keyword_gap",
  schedule: { freshnessDays: 30 },
  provider: "dataforseo",
  subjects: (project) => project.competitors.map(bareDomain),
  request: (project, subject) => {
    if (!subject) throw new Error("keyword_gap needs a competitor domain as subject")
    const target1 = bareDomain(subject)
    return {
      subject: target1,
      params: {
        target1,
        target2: bareDomain(project.domain),
        intersections: false,
        location_name: project.location,
        language_name: project.language,
        limit: LIMIT,
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
          target: p.target1,
          total_count: r[0]?.total_count ?? 0,
          items: (r[0]?.items ?? []).slice(0, LIMIT).map((i) => ({
            keyword: i.keyword_data.keyword,
            search_volume: i.keyword_data.keyword_info?.search_volume ?? null,
            difficulty: i.keyword_data.keyword_properties?.keyword_difficulty ?? null,
            intent: i.keyword_data.search_intent_info?.main_intent ?? null,
            competitor_rank: i.first_domain_serp_element?.rank_absolute ?? null,
            competitor_url: i.first_domain_serp_element?.url ?? null,
          })),
        },
      })),
    ),
  extract: (payload) => [
    { subject: payload.target, key: "gap_keywords", date: payload.date, value: payload.total_count },
  ],
  diff: (prev, cur) => {
    const seen = new Set(prev?.items.map((i) => i.keyword))
    const changes = cur.items
      .filter((i) => !seen.has(i.keyword))
      .map((i) => ({
        subject: i.keyword,
        summary: `new gap keyword "${i.keyword}": ${cur.target} ranks ${i.competitor_rank ?? "?"}, volume ${i.search_volume ?? "unknown"}`,
        magnitude: i.search_volume ?? 0,
      }))
    const delta = cur.total_count - (prev?.total_count ?? 0)
    if (delta !== 0) {
      changes.push({
        subject: cur.target,
        summary: `gap keywords against ${cur.target} ${prev?.total_count ?? 0} -> ${cur.total_count}`,
        magnitude: Math.abs(delta),
      })
    }
    return changes
  },
}

export default collector
