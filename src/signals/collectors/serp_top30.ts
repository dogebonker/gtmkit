import { Effect, Schema } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"
import { bareDomain, maybe } from "../dataforseo"
import { PRICES } from "../prices"

// docs.dataforseo.com/v3/serp/google/organic/live/advanced/
// Billed per 10 results of depth. Only organic items are kept; rank_group is the organic position.
const PATH = "/v3/serp/google/organic/live/advanced"
const DEPTH = 30

interface Params {
  keyword: string
  location_name: string
  language_name: string
  depth: number
  /** The project domain and its competitors, kept in the payload for `extract` and `diff`. Not sent. */
  keep: { tracked: string[] }
}

interface Organic {
  rank: number
  domain: string
  url: string | null
  title: string | null
}

interface Payload {
  date: string
  keyword: string
  tracked: string[]
  items: Organic[]
}

const Result = Schema.Array(
  Schema.Struct({
    items: maybe(
      Schema.Array(
        Schema.Struct({
          type: Schema.String,
          rank_group: maybe(Schema.Number),
          domain: maybe(Schema.String),
          url: maybe(Schema.String),
          title: maybe(Schema.String),
        }),
      ),
    ),
  }),
)
const decode = Schema.decodeUnknownEffect(Result)

const owns = (itemDomain: string, domain: string) => itemDomain === domain || itemDomain.endsWith(`.${domain}`)

/** Best organic position of `domain`, or null when it is not in the top 30. */
const best = (p: Payload, domain: string): number | null => {
  const ranks = p.items.filter((i) => owns(i.domain, domain)).map((i) => i.rank)
  return ranks.length ? Math.min(...ranks) : null
}

const collector: Collector<Params, Payload, "dataforseo"> = {
  kind: "serp_top30",
  schedule: "weekly",
  provider: "dataforseo",
  subjects: (project) => [...new Set(project.keywords.map((k) => k.value.trim().toLowerCase()))],
  request: (project, subject) => {
    if (!subject?.trim()) throw new Error("serp_top30 needs a keyword as subject")
    const keyword = subject.trim().toLowerCase()
    return {
      subject: keyword,
      params: {
        keyword,
        location_name: project.location,
        language_name: project.language,
        depth: DEPTH,
        keep: { tracked: [...new Set([project.domain, ...project.competitors].map(bareDomain))] },
      },
    }
  },
  estimate: (p) => PRICES.serpLivePer10 * Math.ceil(p.depth / 10),
  fetch: ({ keep, ...task }, dataforseo) =>
    dataforseo(PATH, task, decode).pipe(
      Effect.map(({ result: r, costUsd }) => ({
        costUsd,
        payload: {
          date: now().toISOString().slice(0, 10),
          keyword: task.keyword,
          tracked: keep.tracked,
          items: (r[0]?.items ?? [])
            .filter((i) => i.type === "organic" && i.domain && i.rank_group && i.rank_group <= DEPTH)
            .map((i) => ({
              rank: i.rank_group!,
              domain: bareDomain(i.domain!),
              url: i.url ?? null,
              title: i.title ?? null,
            })),
        },
      })),
    ),
  extract: (payload) =>
    payload.tracked.flatMap((domain) => {
      const rank = best(payload, domain)
      return rank === null ? [] : [{ subject: payload.keyword, key: `position:${domain}`, date: payload.date, value: rank }]
    }),
  diff: (prev, cur) => {
    if (!prev) return []
    const changes = []
    const seen = new Set(prev.items.map((i) => i.domain))
    for (const i of cur.items) {
      if (seen.has(i.domain)) continue
      seen.add(i.domain)
      changes.push({
        subject: cur.keyword,
        summary: `${i.domain} entered the top ${DEPTH} for "${cur.keyword}" at ${i.rank}`,
        magnitude: DEPTH + 1 - i.rank,
      })
    }
    for (const domain of cur.tracked) {
      const a = best(prev, domain)
      const b = best(cur, domain)
      if (a === b) continue
      changes.push({
        subject: cur.keyword,
        summary: `${domain} for "${cur.keyword}": ${a ?? `>${DEPTH}`} -> ${b ?? `>${DEPTH}`}`,
        magnitude: Math.abs((a ?? DEPTH + 1) - (b ?? DEPTH + 1)),
      })
    }
    return changes
  },
}

export default collector
