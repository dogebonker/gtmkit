import { Effect, Schema } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"
import { maybe } from "../dataforseo"
import { labsEstimate } from "../prices"

// docs.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live/
const PATH = "/v3/dataforseo_labs/google/keyword_ideas/live"
const LIMIT = 100

interface Params {
  keywords: string[]
  location_name: string
  language_name: string
  limit: number
}

interface Idea {
  keyword: string
  search_volume: number | null
  cpc: number | null
  difficulty: number | null
  intent: string | null
}

interface Payload {
  date: string
  items: Idea[]
}

const Result = Schema.Array(
  Schema.Struct({
    items: maybe(
      Schema.Array(
        Schema.Struct({
          keyword: Schema.String,
          keyword_info: maybe(Schema.Struct({ search_volume: maybe(Schema.Number), cpc: maybe(Schema.Number) })),
          keyword_properties: maybe(Schema.Struct({ keyword_difficulty: maybe(Schema.Number) })),
          search_intent_info: maybe(Schema.Struct({ main_intent: maybe(Schema.String) })),
        }),
      ),
    ),
  }),
)
const decode = Schema.decodeUnknownEffect(Result)

const collector: Collector<Params, Payload, "dataforseo"> = {
  kind: "keyword_ideas",
  schedule: { freshnessDays: 30 },
  provider: "dataforseo",
  subjects: (project) => project.seed_topics,
  request: (project, subject) => {
    if (!subject) throw new Error("keyword_ideas needs a seed topic as subject")
    return {
      subject,
      params: {
        keywords: [subject.toLowerCase()],
        location_name: project.location,
        language_name: project.language,
        limit: LIMIT,
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
          items: (r[0]?.items ?? []).slice(0, LIMIT).map((i) => ({
            keyword: i.keyword,
            search_volume: i.keyword_info?.search_volume ?? null,
            cpc: i.keyword_info?.cpc ?? null,
            difficulty: i.keyword_properties?.keyword_difficulty ?? null,
            intent: i.search_intent_info?.main_intent ?? null,
          })),
        },
      })),
    ),
  extract: () => [],
  diff: (prev, cur) => {
    const seen = new Set(prev?.items.map((i) => i.keyword))
    return cur.items
      .filter((i) => !seen.has(i.keyword))
      .map((i) => ({
        subject: i.keyword,
        summary: `new keyword idea "${i.keyword}" (volume ${i.search_volume ?? "unknown"})`,
        magnitude: i.search_volume ?? 0,
      }))
  },
}

export default collector
