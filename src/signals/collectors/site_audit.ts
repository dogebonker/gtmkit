import { Effect, Schema } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"
import { bareDomain, maybe } from "../dataforseo"
import { PRICES } from "../prices"

// docs.dataforseo.com/v3/on_page/instant_pages/: one live task checks one URL, result[0].items[0] holds the page with
// `checks`, booleans where true means the check matched. A few mean something good; every other true check is an issue.
const PATH = "/v3/on_page/instant_pages"
const LIMIT = 100 // pages per audit, taken in sitemap order
const SITEMAP_FILES = 10 // sitemap and sitemap index files read per audit
const GOOD = new Set(["is_https", "is_www", "has_micromarkup", "has_html_doctype", "canonical", "has_meta_title"])

interface Params {
  url: string
}

interface Page {
  url: string
  status_code: number | null
  onpage_score: number | null
  issues: string[]
}

interface Payload {
  date: string
  url: string
  items: Page[]
}

const Result = Schema.Array(
  Schema.Struct({
    items: maybe(
      Schema.Array(
        Schema.Struct({
          url: maybe(Schema.String),
          status_code: maybe(Schema.Number),
          onpage_score: maybe(Schema.Number),
          checks: maybe(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
    ),
  }),
)
const decode = Schema.decodeUnknownEffect(Result)

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

/** The <loc> values of a sitemap or sitemap index. */
const locs = (xml: string) =>
  [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) =>
    m[1]!.trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]!),
  )

/** The URL, normalised, when it is an http(s) page of the project's domain or a subdomain. */
const onSite = (raw: string, domain: string): string | null => {
  try {
    const url = new URL(raw)
    const host = bareDomain(url.hostname)
    const ours = host === domain || host.endsWith(`.${domain}`)
    return ours && (url.protocol === "http:" || url.protocol === "https:") ? url.href : null
  } catch {
    return null
  }
}

const issuesOf = (p: Payload) => p.items[0]?.issues ?? []

const collector: Collector<Params, Payload, "dataforseo"> = {
  kind: "site_audit",
  schedule: { freshnessDays: 7 },
  provider: "dataforseo",
  // On demand only: the pages come from the sitemap at collection time, so nothing is tracked.
  subjects: () => [],
  // ponytail: reads /sitemap.xml only, not robots.txt Sitemap: lines. Add them when a site keeps its sitemap elsewhere.
  discover: (project, web) =>
    Effect.gen(function* () {
      const domain = bareDomain(project.domain)
      const queue = [`https://${domain}/sitemap.xml`]
      const pages: string[] = []
      for (let files = 0; queue.length > 0 && files < SITEMAP_FILES && pages.length < LIMIT; files++) {
        const { body } = yield* web(queue.shift()!)
        if (/<sitemapindex\b/i.test(body)) queue.push(...locs(body))
        else pages.push(...locs(body).flatMap((u) => onSite(u, domain) ?? []))
      }
      return [...new Set(pages)].slice(0, LIMIT)
    }),
  request: (project, subject) => {
    const domain = bareDomain(project.domain)
    const url = subject && onSite(subject, domain)
    if (!url) throw new Error(`site_audit needs a page URL of ${domain} as subject, or none to audit up to ${LIMIT} pages of its sitemap`)
    return { subject: url, params: { url } }
  },
  estimate: () => PRICES.onPageInstant,
  fetch: (p, dataforseo) =>
    dataforseo(PATH, { url: p.url }, decode).pipe(
      Effect.map(({ result: r, costUsd }) => ({
        costUsd,
        payload: {
          date: now().toISOString().slice(0, 10),
          url: p.url,
          items: (r[0]?.items ?? []).slice(0, 1).map((i) => ({
            url: i.url ?? p.url,
            status_code: i.status_code ?? null,
            onpage_score: i.onpage_score ?? null,
            issues: Object.entries(i.checks ?? {})
              .filter(([k, v]) => v === true && !GOOD.has(k) && !k.startsWith("seo_friendly_url"))
              .map(([k]) => k)
              .sort(),
          })),
        },
      })),
    ),
  extract: (payload) =>
    payload.items.length ? [{ subject: payload.url, key: "issues", date: payload.date, value: issuesOf(payload).length }] : [],
  diff: (prev, cur) => {
    if (!prev) return []
    const before = issuesOf(prev)
    const after = issuesOf(cur)
    const added = after.filter((i) => !before.includes(i))
    const fixed = before.filter((i) => !after.includes(i))
    if (added.length + fixed.length === 0) return []
    return [
      {
        subject: cur.url,
        summary: `${cur.url}: issues ${before.length} -> ${after.length}${added.length ? `, new: ${added.join(", ")}` : ""}${fixed.length ? `, fixed: ${fixed.join(", ")}` : ""}`,
        magnitude: added.length + fixed.length,
      },
    ]
  },
}

export default collector
