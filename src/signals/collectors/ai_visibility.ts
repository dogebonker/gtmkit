import { Effect, Schema } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"
import { bareDomain, maybe } from "../dataforseo"
import { PRICES } from "../prices"

// docs.dataforseo.com/v3/ai_optimization/{chat_gpt,perplexity,gemini,claude}/llm_responses/live/
// Answer text: result[0].items[type=message].sections[type=text].text. Sources: the sections' annotations[].url
// (Gemini: direct_url, its url is a Vertex AI redirect) and result[0].search_results[].url (not on Gemini).
// Perplexity sonar models search the web by default. The others search only with web_search: true. Models from
// docs.dataforseo.com/v3/ai_optimization/{gemini,claude}/llm_responses/models/, both listed with web search support.
// The only cost-bounding request fields the docs list: max_output_tokens (every engine; its default, sent explicitly)
// and use_reasoning (Gemini and Claude; off). With web_search the docs say output may exceed max_output_tokens, and no
// engine takes a limit on the number of searches. See the ceilings in ../prices.ts.
const MAX_OUTPUT_TOKENS = 2048
const ENGINES: Record<string, { path: string; task: Record<string, unknown> }> = {
  chatgpt: {
    path: "/v3/ai_optimization/chat_gpt/llm_responses/live",
    task: { model_name: "gpt-4.1-mini", web_search: true, max_output_tokens: MAX_OUTPUT_TOKENS },
  },
  perplexity: { path: "/v3/ai_optimization/perplexity/llm_responses/live", task: { model_name: "sonar", max_output_tokens: MAX_OUTPUT_TOKENS } },
  gemini: {
    path: "/v3/ai_optimization/gemini/llm_responses/live",
    task: { model_name: "gemini-2.5-flash", web_search: true, max_output_tokens: MAX_OUTPUT_TOKENS, use_reasoning: false },
  },
  claude: {
    path: "/v3/ai_optimization/claude/llm_responses/live",
    task: { model_name: "claude-haiku-4-5", web_search: true, max_output_tokens: MAX_OUTPUT_TOKENS, use_reasoning: false },
  },
}
// The weekly run. Gemini and Claude are collected on demand only, until S0 measures what an answer costs.
const DEFAULT_ENGINES = ["chatgpt", "perplexity"]

interface Params {
  engine: string
  user_prompt: string
  /** Kept in the payload for `extract` and `diff`. Not sent. */
  keep: { brands: string[]; domain: string; competitors: string[] }
}

interface Payload {
  date: string
  engine: string
  prompt: string
  brands: string[]
  domain: string
  /** Competitor domains. Absent in payloads stored before competitors were tracked. */
  competitors?: string[]
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
                annotations: maybe(Schema.Array(Schema.Struct({ url: maybe(Schema.String), direct_url: maybe(Schema.String) }))),
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

const wholeWord = (text: string, pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, "iu").test(text)

/** A brand name as a whole word, case-insensitive. */
const mentions = (text: string, brand: string) => brand.trim() !== "" && wholeWord(text, escape(brand.trim()))

// ponytail: competitors have no brand name, so the first label of the domain stands in for it, a hyphen matching a
// hyphen, a space or nothing ("rival-one.com": "Rival One", "RivalOne"). A generic label ("app.example.com", "go.com")
// over-counts and a brand unlike its domain is missed. Add a brand name per competitor if that matters.
const mentionsDomain = (text: string, domain: string) => {
  const label = domain.split(".")[0]!
  return label !== "" && wholeWord(text, label.split("-").map(escape).join("[-\\s]?"))
}

const hostOf = (url: string) => {
  try {
    return bareDomain(new URL(url).hostname)
  } catch {
    return ""
  }
}

const KEYS = ["mentioned", "cited"] as const

const cites = (sources: string[], domain: string) =>
  sources.some((u) => {
    const host = hostOf(u)
    return host === domain || host.endsWith(`.${domain}`)
  })

const visibility = (p: Payload) => {
  const answer = p.items[0]?.answer ?? ""
  const sources = p.items[0]?.sources ?? []
  return {
    mentioned: p.brands.some((b) => mentions(answer, b)) ? 1 : 0,
    cited: cites(sources, p.domain) ? 1 : 0,
    competitors: (p.competitors ?? []).map((domain) => ({
      domain,
      mentioned: mentionsDomain(answer, domain) ? 1 : 0,
      cited: cites(sources, domain) ? 1 : 0,
    })),
  }
}

const collector: Collector<Params, Payload, "dataforseo"> = {
  kind: "ai_visibility",
  schedule: "weekly",
  provider: "dataforseo",
  subjects: (project) => project.prompts.flatMap((prompt) => DEFAULT_ENGINES.map((e) => subjectOf(e, prompt))),
  request: (project, subject) => {
    const m = /^(\w+): ([\s\S]+)$/.exec(subject ?? "")
    // Own keys only: an inherited name such as `constructor` is not an engine.
    if (!m || !Object.hasOwn(ENGINES, m[1]!)) {
      throw new Error(`ai_visibility needs a subject "<engine>: <prompt>", engines: ${Object.keys(ENGINES).join(", ")}`)
    }
    const engine = m[1]!
    const prompt = m[2]!
    return {
      subject: subjectOf(engine, prompt),
      params: {
        engine,
        user_prompt: prompt,
        keep: { brands: project.brand_names, domain: bareDomain(project.domain), competitors: project.competitors.map(bareDomain) },
      },
    }
  },
  estimate: (p) => PRICES.llmTask + PRICES.llmModelMax[p.engine as keyof typeof PRICES.llmModelMax],
  fetch: (p, dataforseo) => {
    const engine = ENGINES[p.engine]!
    return dataforseo(engine.path, { ...engine.task, user_prompt: p.user_prompt }, decode).pipe(
      Effect.map(({ result: r, costUsd }) => {
        const sections = (r[0]?.items ?? [])
          .filter((i) => i.type === "message")
          .flatMap((i) => i.sections ?? [])
          .filter((s) => s.type === "text")
        const urls = [
          ...sections.flatMap((s) => (s.annotations ?? []).map((a) => a.direct_url ?? a.url)),
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
            competitors: p.keep.competitors,
            items: [{ answer: sections.map((s) => s.text ?? "").join("\n"), sources: [...new Set(urls)] }],
          },
        }
      }),
    )
  },
  extract: (payload) => {
    const v = visibility(payload)
    const subject = subjectOf(payload.engine, payload.prompt)
    return [
      ...KEYS.map((key) => ({ subject, key, date: payload.date, value: v[key] })),
      ...v.competitors.flatMap((c) => KEYS.map((key) => ({ subject, key: `${key}:${c.domain}`, date: payload.date, value: c[key] }))),
    ]
  },
  diff: (prev, cur) => {
    // An empty answer on either side is missing data, not a change.
    if (!prev?.items[0]?.answer || !cur.items[0]?.answer) return []
    const a = visibility(prev)
    const b = visibility(cur)
    const subject = subjectOf(cur.engine, cur.prompt)
    const verb = (key: (typeof KEYS)[number], on: number) => `${on ? "now" : "no longer"} ${key === "mentioned" ? "mentions" : "cites"}`
    const own = KEYS.flatMap((key) =>
      a[key] === b[key]
        ? []
        : [{ subject, summary: `${cur.engine} ${verb(key, b[key])} ${key === "mentioned" ? "the brand" : cur.domain} for "${cur.prompt}"`, magnitude: 1 }],
    )
    // A competitor's move ranks below the project's own changes, and says where the project stands.
    const rivals = KEYS.flatMap((key) => {
      const project = `${key === "mentioned" ? "the brand" : cur.domain} is ${a[key] === b[key] ? `still ${b[key] ? "" : "not "}` : b[key] ? "now " : "no longer "}${key}`
      return b.competitors.flatMap((c) => {
        const before = a.competitors.find((x) => x.domain === c.domain)
        if (!before || before[key] === c[key]) return []
        return [{ subject, summary: `${cur.engine} ${verb(key, c[key])} competitor ${c.domain} for "${cur.prompt}"; ${project}`, magnitude: 0.5 }]
      })
    })
    return [...own, ...rivals]
  },
}

export default collector
