import { Effect, Schema } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"
import { bareDomain, maybe } from "../dataforseo"
import { PRICES } from "../prices"

// docs.dataforseo.com/v3/ai_optimization/chat_gpt/llm_responses/live/ and .../perplexity/llm_responses/live/
// Answer text: result[0].items[type=message].sections[type=text].text. Sources: the sections' annotations[].url
// and result[0].search_results[].url. Perplexity sonar models search the web by default.
const ENGINES: Record<string, { path: string; task: Record<string, unknown> }> = {
  chatgpt: { path: "/v3/ai_optimization/chat_gpt/llm_responses/live", task: { model_name: "gpt-4.1-mini", web_search: true } },
  perplexity: { path: "/v3/ai_optimization/perplexity/llm_responses/live", task: { model_name: "sonar" } },
}
const DEFAULT_ENGINES = ["chatgpt", "perplexity"]

interface Params {
  engine: string
  user_prompt: string
  /** Kept in the payload for `extract` and `diff`. Not sent. */
  keep: { brands: string[]; domain: string }
}

interface Payload {
  date: string
  engine: string
  prompt: string
  brands: string[]
  domain: string
  items: { answer: string; sources: string[] }[]
}

const Result = Schema.Array(
  Schema.Struct({
    items: maybe(
      Schema.Array(
        Schema.Struct({
          type: Schema.String,
          sections: maybe(
            Schema.Array(
              Schema.Struct({
                type: Schema.String,
                text: maybe(Schema.String),
                annotations: maybe(Schema.Array(Schema.Struct({ url: maybe(Schema.String) }))),
              }),
            ),
          ),
        }),
      ),
    ),
    search_results: maybe(Schema.Array(Schema.Struct({ url: maybe(Schema.String) }))),
  }),
)
const decode = Schema.decodeUnknownEffect(Result)

const subjectOf = (engine: string, prompt: string) => `${engine}: ${prompt}`

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** A brand name as a whole word, case-insensitive. */
const mentions = (text: string, brand: string) =>
  brand.trim() !== "" && new RegExp(`(?<![\\p{L}\\p{N}_])${escape(brand.trim())}(?![\\p{L}\\p{N}_])`, "iu").test(text)

const hostOf = (url: string) => {
  try {
    return bareDomain(new URL(url).hostname)
  } catch {
    return ""
  }
}

const visibility = (p: Payload) => {
  const answer = p.items[0]?.answer ?? ""
  const sources = p.items[0]?.sources ?? []
  return {
    mentioned: p.brands.some((b) => mentions(answer, b)) ? 1 : 0,
    cited: sources.some((u) => {
      const host = hostOf(u)
      return host === p.domain || host.endsWith(`.${p.domain}`)
    })
      ? 1
      : 0,
  }
}

const collector: Collector<Params, Payload, "dataforseo"> = {
  kind: "ai_visibility",
  schedule: "weekly",
  provider: "dataforseo",
  subjects: (project) => project.prompts.flatMap((prompt) => DEFAULT_ENGINES.map((e) => subjectOf(e, prompt))),
  request: (project, subject) => {
    const m = /^(\w+): ([\s\S]+)$/.exec(subject ?? "")
    if (!m || !ENGINES[m[1]!]) {
      throw new Error(`ai_visibility needs a subject "<engine>: <prompt>", engines: ${Object.keys(ENGINES).join(", ")}`)
    }
    const engine = m[1]!
    const prompt = m[2]!
    return {
      subject: subjectOf(engine, prompt),
      params: { engine, user_prompt: prompt, keep: { brands: project.brand_names, domain: bareDomain(project.domain) } },
    }
  },
  estimate: () => PRICES.llmTask + PRICES.llmModelMax,
  fetch: (p, dataforseo) => {
    const engine = ENGINES[p.engine]!
    return dataforseo(engine.path, { ...engine.task, user_prompt: p.user_prompt }, decode).pipe(
      Effect.map(({ result: r, costUsd }) => {
        const sections = (r[0]?.items ?? [])
          .filter((i) => i.type === "message")
          .flatMap((i) => i.sections ?? [])
          .filter((s) => s.type === "text")
        const urls = [
          ...sections.flatMap((s) => (s.annotations ?? []).map((a) => a.url)),
          ...(r[0]?.search_results ?? []).map((s) => s.url),
        ].filter((u): u is string => !!u)
        return {
          costUsd,
          payload: {
            date: now().toISOString().slice(0, 10),
            engine: p.engine,
            prompt: p.user_prompt,
            brands: p.keep.brands,
            domain: p.keep.domain,
            items: [{ answer: sections.map((s) => s.text ?? "").join("\n"), sources: [...new Set(urls)] }],
          },
        }
      }),
    )
  },
  extract: (payload) => {
    const v = visibility(payload)
    const subject = subjectOf(payload.engine, payload.prompt)
    return (["mentioned", "cited"] as const).map((key) => ({ subject, key, date: payload.date, value: v[key] }))
  },
  diff: (prev, cur) => {
    // An empty answer on either side is missing data, not a change.
    if (!prev?.items[0]?.answer || !cur.items[0]?.answer) return []
    const a = visibility(prev)
    const b = visibility(cur)
    return (["mentioned", "cited"] as const).flatMap((key) =>
      a[key] === b[key]
        ? []
        : [
            {
              subject: subjectOf(cur.engine, cur.prompt),
              summary: `${cur.engine} ${b[key] ? "now" : "no longer"} ${key === "mentioned" ? "mentions the brand" : `cites ${cur.domain}`} for "${cur.prompt}"`,
              magnitude: 1,
            },
          ],
    )
  },
}

export default collector
