import { Effect, Schema } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"
import { bareDomain, maybe } from "../dataforseo"
import { PRICES } from "../prices"

// docs.dataforseo.com/v3/serp/google/organic/live/advanced/
// Billed per 10 results of depth. Only organic items are kept; rank_group is the organic position.
// An `ai_overview` item lists `references` (each with a `domain`), and so does each element in its `items`.
// ponytail: load_async_ai_overview is left off: it costs $0.002 more per call and returns AI Overviews Google loads
// asynchronously. Without it only cached AI Overviews come back, so ai_overview 0 can be a miss. Turn it on, and raise
// PRICES and the estimate by $0.002, if AI Overviews matter more than that.
const PATH = "/v3/serp/google/organic/live/advanced"
const DEPTH = 30
const AI_OVERVIEW_REFERENCES = 20
const DOMAIN_CHARS = 253 // the longest DNS name

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
  /** The project domain first, then its competitors. */
  tracked: string[]
  /**
   * null when the result has no AI Overview. `references`: the domains it references, at most 20. `cited`: the tracked
   * domains among all of them, found before the cut. Absent in payloads stored before AI Overviews were tracked.
   */
  ai_overview?: { references: string[]; cited: string[] } | null
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
          // Only read on the ai_overview item, by `referenced`: other item types use these names for other shapes.
          references: maybe(Schema.Unknown),
          items: maybe(Schema.Unknown),
        }),
      ),
    ),
  }),
)

const decode = Schema.decodeUnknownEffect(Result)

const domainsOf = (refs: unknown): string[] =>
  Array.isArray(refs)
    ? refs.flatMap((r: { domain?: unknown }) => (typeof r?.domain === "string" ? [bareDomain(r.domain).slice(0, DOMAIN_CHARS)] : []))
    : []

/** The AI Overview's referenced domains: its own references, then each element's. */
const referenced = (item: { references?: unknown; items?: unknown }) => [
  ...new Set([
    ...domainsOf(item.references),
    ...(Array.isArray(item.items) ? item.items.flatMap((e: { references?: unknown }) => domainsOf(e?.references)) : []),
  ]),
]

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
      Effect.map(({ result: r, costUsd }) => {
        const item = (r[0]?.items ?? []).find((i) => i.type === "ai_overview")
        const refs = item ? referenced(item) : []
        return {
          costUsd,
          payload: {
            date: now().toISOString().slice(0, 10),
            keyword: task.keyword,
            tracked: keep.tracked,
            ai_overview: item
              ? // `cited` first: the MCP adapter cuts metadata at 2,000 characters, and long reference domains must not push it out.
                { cited: keep.tracked.filter((d) => refs.some((x) => owns(x, d))), references: refs.slice(0, AI_OVERVIEW_REFERENCES) }
              : null,
            items: (r[0]?.items ?? [])
              .filter((i) => i.type === "organic" && i.domain && i.rank_group && i.rank_group <= DEPTH)
              .map((i) => ({
                rank: i.rank_group!,
                domain: bareDomain(i.domain!),
                url: i.url ?? null,
                title: i.title ?? null,
              })),
          },
        }
      }),
    ),
  extract: (payload) => {
    const at = { subject: payload.keyword, date: payload.date }
    const positions = payload.tracked.flatMap((domain) => {
      const rank = best(payload, domain)
      return rank === null ? [] : [{ ...at, key: `position:${domain}`, value: rank }]
    })
    if (payload.ai_overview === undefined) return positions
    const cited = (domain: string) => (payload.ai_overview?.cited.includes(domain) ? 1 : 0)
    const [own, ...competitors] = payload.tracked
    return [
      ...positions,
      { ...at, key: "ai_overview", value: payload.ai_overview ? 1 : 0 },
      ...(own ? [{ ...at, key: "ai_overview_cited", value: cited(own) }] : []),
      ...competitors.map((d) => ({ ...at, key: `ai_overview_cited:${d}`, value: cited(d) })),
    ]
  },
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
