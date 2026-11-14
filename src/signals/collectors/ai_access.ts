import { Effect } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"
import { bareDomain } from "../dataforseo"
import type { FetchPage } from "../fetcher"

// https://<domain>/robots.txt and /llms.txt through the guarded page fetcher. Free. A 4xx other than 429 means the
// file is missing, which is data: no robots.txt allows every crawler (RFC 9309 section 2.3.1.3). That includes 401 and
// 403, so a firewall that blocks this fetcher reads as "allowed". A 429, 5xx or network error on robots.txt fails the
// snapshot, as it does for page_watch. The same on llms.txt alone leaves llms_txt unknown and keeps robots.txt.
const BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot", "Google-Extended"]
// ponytail: rules past 100 KB of robots.txt are ignored (Google reads 500 KiB). Raise it if a site needs more.
const ROBOTS_BYTES = 100_000
const LLMS_BYTES = 10_000

interface Params {
  domain: string
}

interface File {
  file: "robots.txt" | "llms.txt"
  /** null: the file could not be read (llms.txt only). */
  found: boolean | null
  body: string
}

interface Payload {
  date: string
  domain: string
  /** The verdicts at capture, from `items`: metadata, so MCP returns them whole while it cuts each body at 2,000 chars. */
  allowed?: Record<string, number>
  llms_txt?: number | null
  items: File[]
}

const cut = (s: string, bytes: number) => Buffer.from(s).subarray(0, bytes).toString("utf8")

/** The file's body, or null when the site answers a 4xx other than 429. */
const read = (web: FetchPage, url: string) =>
  web(url).pipe(
    Effect.map((page) => page.body as string | null),
    Effect.catchTag("ProviderError", (e) =>
      e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429 ? Effect.succeed(null) : Effect.fail(e),
    ),
  )

/** Rules of the groups naming `agent`, or of the `*` groups when none does. */
const rulesFor = (robots: string, agent: string) => {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = []
  let collectingAgents = false
  for (const raw of robots.split(/\r\n|\r|\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/#.*/, ""))
    if (!m) continue
    const field = m[1]!.toLowerCase()
    if (field === "user-agent") {
      if (!collectingAgents) groups.push({ agents: [], rules: [] })
      // The leading product token: "GPTBot/1.1" applies to GPTBot.
      groups.at(-1)!.agents.push(/^(\*|[A-Za-z_-]+)/.exec(m[2]!)?.[1]?.toLowerCase() ?? "")
      collectingAgents = true
    } else if ((field === "allow" || field === "disallow") && groups.length) {
      groups.at(-1)!.rules.push({ allow: field === "allow", path: m[2]! })
      collectingAgents = false
    }
  }
  const own = groups.filter((g) => g.agents.includes(agent.toLowerCase()))
  return (own.length ? own : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules)
}

/** May `agent` fetch `/`? The longest matching rule wins, Allow on a tie. An empty rule matches nothing. */
const allowsRoot = (robots: string, agent: string) => {
  const matching = rulesFor(robots, agent).filter(
    (r) => r.path !== "" && new RegExp(`^${r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`).test("/"),
  )
  const longest = Math.max(-1, ...matching.map((r) => r.path.length))
  return longest < 0 || matching.some((r) => r.allow && r.path.length === longest)
}

const access = (p: Payload) => {
  const robots = p.items.find((i) => i.file === "robots.txt")
  const llms = p.items.find((i) => i.file === "llms.txt")
  return {
    bots: BOTS.map((bot) => ({ bot, allowed: !robots?.found || allowsRoot(robots.body, bot) ? 1 : 0 })),
    // ponytail: a 2xx whose body starts with "<" is taken for an HTML soft 404, anything else for an llms.txt.
    llms_txt: llms?.found === null ? null : llms?.found && !llms.body.trimStart().startsWith("<") ? 1 : 0,
  }
}

const collector: Collector<Params, Payload, "web"> = {
  kind: "ai_access",
  schedule: "weekly",
  provider: "web",
  subjects: (project) => [bareDomain(project.domain)],
  request: (project, subject) => {
    const domain = bareDomain(subject ?? project.domain)
    if (!domain || URL.parse(`https://${domain}/`)?.host !== domain) throw new Error(`ai_access needs a domain as subject, got ${subject}`)
    return { subject: domain, params: { domain } }
  },
  estimate: () => 0,
  fetch: (p, web) =>
    Effect.all([
      read(web, `https://${p.domain}/robots.txt`),
      read(web, `https://${p.domain}/llms.txt`).pipe(Effect.catchTag("ProviderError", () => Effect.succeed(undefined))),
    ]).pipe(
      Effect.map(([robots, llms]) => {
        const items: File[] = [
          { file: "robots.txt", found: robots !== null, body: cut(robots ?? "", ROBOTS_BYTES) },
          { file: "llms.txt", found: llms === undefined ? null : llms !== null, body: cut(llms ?? "", LLMS_BYTES) },
        ]
        const a = access({ date: "", domain: p.domain, items })
        return {
          costUsd: 0,
          payload: {
            date: now().toISOString().slice(0, 10),
            domain: p.domain,
            allowed: Object.fromEntries(a.bots.map((b) => [b.bot, b.allowed])),
            llms_txt: a.llms_txt,
            items,
          },
        }
      }),
    ),
  extract: (payload) => {
    const a = access(payload)
    const at = { subject: payload.domain, date: payload.date }
    return [
      ...a.bots.map((b) => ({ ...at, key: `allowed:${b.bot}`, value: b.allowed })),
      ...(a.llms_txt === null ? [] : [{ ...at, key: "llms_txt", value: a.llms_txt }]),
    ]
  },
  diff: (prev, cur) => {
    if (!prev) return []
    const a = access(prev)
    const b = access(cur)
    const bots = b.bots.flatMap(({ bot, allowed }) =>
      a.bots.find((x) => x.bot === bot)?.allowed === allowed
        ? []
        : [{ subject: cur.domain, summary: `${cur.domain}: ${bot} is now ${allowed ? "allowed" : "blocked"} by robots.txt`, magnitude: 1 }],
    )
    const llms =
      a.llms_txt === null || b.llms_txt === null || a.llms_txt === b.llms_txt
        ? []
        : [{ subject: cur.domain, summary: `${cur.domain}: llms.txt ${b.llms_txt ? "appeared" : "disappeared"}`, magnitude: 1 }]
    return [...bots, ...llms]
  },
}

export default collector
