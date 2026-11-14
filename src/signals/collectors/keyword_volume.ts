import { Effect, Schema } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"
import { maybe } from "../dataforseo"
import { labsEstimate } from "../prices"

// docs.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live/
// Up to 700 keywords per task, volume and keyword difficulty per keyword. Labs price: per task plus per item.
// Keywords missing from the Labs database are left out of `items` and not charged.
const PATH = "/v3/dataforseo_labs/google/keyword_overview/live"

interface Params {
  keywords: string[]
  location_name: string
  language_name: string
}

interface Overview {
  keyword: string
  search_volume: number | null
  difficulty: number | null
  cpc: number | null
}

interface Payload {
  date: string
  items: Overview[]
}

const Result = Schema.Array(
  Schema.Struct({
    items: maybe(
      Schema.Array(
        Schema.Struct({
          keyword: Schema.String,
          keyword_info: maybe(Schema.Struct({ search_volume: maybe(Schema.Number), cpc: maybe(Schema.Number) })),
          keyword_properties: maybe(Schema.Struct({ keyword_difficulty: maybe(Schema.Number) })),
        }),
      ),
    ),
  }),
)
const decode = Schema.decodeUnknownEffect(Result)

const collector: Collector<Params, Payload, "dataforseo"> = {
  kind: "keyword_volume",
  schedule: { freshnessDays: 30 },
  provider: "dataforseo",
  subjects: (project) => (project.keywords.length ? ["tracked"] : []),
  request: (project) => {
    const keywords = [...new Set(project.keywords.map((k) => k.value.toLowerCase()))].sort()
    if (keywords.length === 0) throw new Error("keyword_volume needs tracked keywords")
    return {
      subject: "tracked",
      params: { keywords, location_name: project.location, language_name: project.language },
    }
  },
  estimate: (p) => labsEstimate(p.keywords.length),
  fetch: (p, dataforseo) =>
    dataforseo(PATH, { ...p }, (result) => decode(result ?? [])).pipe(
      Effect.map(({ result: r, costUsd }) => ({
        costUsd,
        payload: {
          date: now().toISOString().slice(0, 10),
          items: (r[0]?.items ?? []).map((i) => ({
            keyword: i.keyword,
            search_volume: i.keyword_info?.search_volume ?? null,
            difficulty: i.keyword_properties?.keyword_difficulty ?? null,
            cpc: i.keyword_info?.cpc ?? null,
          })),
        },
      })),
    ),
  extract: (payload) =>
    payload.items.flatMap((i) => [
      ...(i.search_volume === null ? [] : [{ subject: i.keyword, key: "volume", date: payload.date, value: i.search_volume }]),
      ...(i.difficulty === null ? [] : [{ subject: i.keyword, key: "difficulty", date: payload.date, value: i.difficulty }]),
    ]),
  diff: (prev, cur) => {
    const before = new Map(prev?.items.map((i) => [i.keyword, i.search_volume]))
    return cur.items.flatMap((i) => {
      const old = before.get(i.keyword) ?? null
      // A volume missing on either side, or a newly tracked keyword, is unknown, not a change.
      if (old === null || i.search_volume === null || old === i.search_volume) return []
      return [{ subject: i.keyword, summary: `volume ${old} -> ${i.search_volume}`, magnitude: Math.abs(i.search_volume - old) }]
    })
  },
}

export default collector
