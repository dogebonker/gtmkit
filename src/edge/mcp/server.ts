import type { Database } from "bun:sqlite"
import { McpServer } from "@modelcontextprotocol/server"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { createActions } from "../../actions"
import { now } from "../../env"
import { getProject, upsertProject } from "../../projects"
import { bucketOf, collectors, createSignals, type Providers, type Snapshot } from "../../signals"

const UNTRUSTED_ITEM_CHARS = 2000
const QUERY_LIMIT = 20
const QUERY_LIMIT_MAX = 100

const cap = (s: string) => s.slice(0, UNTRUSTED_ITEM_CHARS)

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }],
  isError,
})

/**
 * Provider rows are data, never instructions: each one goes back as capped text in a marked field. The other payload
 * fields go back the same way, as one capped text: some are attacker-chosen (page_watch's final_url, via a redirect).
 */
const mark = ({ payload, ...snapshot }: Snapshot) => {
  const { items = [], ...meta } = (payload ?? {}) as { items?: unknown[] }
  return {
    ...snapshot,
    untrusted_provider_data: items.map((i) => cap(JSON.stringify(i))),
    untrusted_provider_meta: cap(JSON.stringify(meta)),
  }
}

/** Error results for refusals: the model reads the reason and can correct its call. */
const attempt = (f: () => unknown) => {
  try {
    return text(f())
  } catch (e) {
    return text((e as Error).message, true)
  }
}

// The plugin's playbooks are the single source: the headless brief and the MCP prompts read these files.
const SKILLS = fileURLToPath(new URL("../../../plugin/skills/", import.meta.url))
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/

/** A playbook's text without its frontmatter, with `$ARGUMENTS` replaced. */
export const playbook = (name: string, args = "") =>
  readFileSync(join(SKILLS, name, "SKILL.md"), "utf8").replace(FRONTMATTER, "").replaceAll("$ARGUMENTS", args).trim()

const playbooks = () =>
  readdirSync(SKILLS).map((name) => {
    const head = FRONTMATTER.exec(readFileSync(join(SKILLS, name, "SKILL.md"), "utf8"))?.[1] ?? ""
    return { name, description: /^description: (.*)$/m.exec(head)?.[1] ?? name }
  })

/**
 * `briefOnly` registers only project_get, signals_query, digest, actions_list, actions_propose and brief_save: the
 * server the unattended weekly brief talks to has no tool that spends money or changes a project. `prompts` also
 * serves every playbook as an MCP prompt, for agents that connect without the plugin.
 */
export const createServer = (db: Database, providers: Providers, { briefOnly = false, prompts = false } = {}) => {
  const signals = createSignals(db, providers)
  const actions = createActions(db, signals)
  const kinds = [...collectors.keys()] as [string, ...string[]]
  const server = new McpServer({ name: "gtmkit", version: "0.1.0" })

  if (prompts) {
    for (const p of playbooks()) {
      server.registerPrompt(
        p.name,
        { description: p.description, argsSchema: z.object({ arguments: z.string().optional() }) },
        ({ arguments: args }) => ({
          messages: [{ role: "user" as const, content: { type: "text" as const, text: playbook(p.name, args) } }],
        }),
      )
    }
  }

  server.registerTool(
    "project_get",
    { description: "Read a project's profile and tracked items.", inputSchema: z.object({ project_id: z.string() }) },
    ({ project_id }) => {
      const project = getProject(db, project_id)
      return project ? text(project) : text(`unknown project ${project_id}`, true)
    },
  )

  if (!briefOnly) {
    server.registerTool(
      "project_upsert",
      {
        description:
          "Create a project (omit id) or update one. Omitted fields keep their value. A tracked list (keywords, prompts, urls), when given, replaces that list. Limits: 200 keywords, 30 prompts, 20 urls. location and language are DataForSEO names, e.g. 'United States' and 'English'. Spend caps cannot be set here.",
        inputSchema: z.object({
          id: z.string().optional(),
          domain: z.string().optional(),
          brand_names: z.array(z.string()).optional(),
          location: z.string().optional(),
          language: z.string().optional(),
          competitors: z.array(z.string()).optional(),
          seed_topics: z.array(z.string()).optional(),
          positioning: z.string().optional(),
          keywords: z
            .array(z.object({ value: z.string(), cluster: z.string().nullish(), intent: z.string().nullish() }))
            .optional(),
          prompts: z.array(z.string()).optional(),
          urls: z.array(z.string()).optional(),
        }),
      },
      (input) => {
        try {
          return text(upsertProject(db, input))
        } catch (e) {
          return text((e as Error).message, true)
        }
      },
    )

    server.registerTool(
      "signals_collect",
      {
        description:
          "Buy one snapshot from the data provider, within the spend caps. subject: the seed topic for keyword_ideas, the competitor domain for competitor_keywords and keyword_gap, a keyword for serp_top30, '<engine>: <prompt>' for ai_visibility (engines chatgpt, perplexity), a URL for page_watch, a domain for backlinks_summary (default the project domain), a page URL of the project's site for site_audit, or no subject to audit up to 100 pages of its sitemap in one call (status 'set': the whole set is refused unless its estimate fits the caps); ignored for keyword_volume (tracked keywords) and gsc_performance (project domain). A repeat inside the same period returns the stored snapshot at no cost. dry_run returns the estimate in USD and makes no call.",
        inputSchema: z.object({
          project_id: z.string(),
          kind: z.enum(kinds),
          subject: z.string().optional(),
          dry_run: z.boolean().optional(),
        }),
      },
      async ({ project_id, kind, subject, dry_run }) => {
        const r = await signals.collect(project_id, kind, { subject }, dry_run ?? false)
        if (r.status === "fresh" || r.status === "collected") return text({ status: r.status, snapshot: mark(r.snapshot) })
        // Failure reasons quote providers and fetched pages (a redirect's hostname, a provider's message).
        if (r.status === "failed") {
          const { reason, ...rest } = r
          return text({ ...rest, untrusted_reason: cap(reason) }, true)
        }
        if (r.status === "set") {
          const { failed, ...rest } = r
          return text({ ...rest, untrusted_failed: failed.map(cap) })
        }
        return text(r, r.status === "refused")
      },
    )
  }

  server.registerTool(
    "signals_query",
    {
      description: `Read stored snapshots of one kind, newest first, at most limit (default ${QUERY_LIMIT}, at most ${QUERY_LIMIT_MAX}). from and to are ISO 8601 times.`,
      inputSchema: z.object({
        project_id: z.string(),
        kind: z.enum(kinds),
        subject: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(QUERY_LIMIT_MAX).optional(),
      }),
    },
    ({ project_id, kind, subject, from, to, limit }) =>
      text({ snapshots: signals.query(project_id, kind, subject, { from, to }, limit ?? QUERY_LIMIT).map(mark) }),
  )

  server.registerTool(
    "digest",
    {
      description:
        "What changed in a week against the latest earlier data, per kind: up to 20 changes sorted by magnitude, each with `evidence` (the earlier and the current snapshot id), and coverage (subjects collected of subjects tracked). Missing data is unknown, not a change. period: ISO week like 2026-W46, default the current week.",
      inputSchema: z.object({ project_id: z.string(), period: z.string().optional() }),
    },
    ({ project_id, period }) => {
      try {
        const d = signals.digest(project_id, period)
        return text({
          ...d,
          kinds: Object.fromEntries(
            Object.entries(d.kinds).map(([kind, k]) => [
              kind,
              {
                coverage: k.coverage,
                changes: k.changes.map((c) => ({
                  magnitude: c.magnitude,
                  evidence: c.evidence,
                  untrusted_change: JSON.stringify({ subject: c.subject, summary: c.summary }).slice(0, UNTRUSTED_ITEM_CHARS),
                })),
              },
            ]),
          ),
        })
      } catch (e) {
        return text((e as Error).message, true)
      }
    },
  )

  server.registerTool(
    "actions_list",
    {
      description:
        "Every action of the project with its status (proposed, accepted, done, dropped), evidence and target metric. A done action carries `delta` once 4 weeks have passed since done_at: the target's baseline (latest value on or before done_at), current value and their difference. It is a delta, not proof. `shared_target` marks done actions whose target another done action shares.",
      inputSchema: z.object({ project_id: z.string() }),
    },
    ({ project_id }) => text({ actions: actions.list(project_id) }),
  )

  server.registerTool(
    "actions_propose",
    {
      description:
        "Propose one GTM action. evidence: snapshot ids of this project, from the `evidence` of digest changes or from signals_query. target: the metric the action should move, as stored: serp_top30 / <keyword> / position:<domain>; gsc_performance / <query>, or TOTAL for the whole site / clicks, impressions or position; ai_visibility / '<engine>: <prompt>' / mentioned or cited; page_watch / <url> / changed_chars; keyword_volume / <keyword> / volume or difficulty; competitor_keywords / <competitor domain> / ranked_keywords; keyword_gap / <competitor domain> / gap_keywords; backlinks_summary / <domain> / referring_domains or backlinks; site_audit / <page url> / issues. Rejected unless every evidence id is a stored snapshot of this project and the target is named.",
      inputSchema: z.object({
        project_id: z.string(),
        title: z.string(),
        rationale: z.string(),
        evidence: z.array(z.number().int()),
        target: z.object({ kind: z.enum(kinds), subject: z.string(), key: z.string() }),
      }),
    },
    ({ project_id, ...input }) => attempt(() => actions.propose(project_id, input)),
  )

  if (!briefOnly) {
    server.registerTool(
      "actions_update",
      {
        description:
          "Record the owner's decision on an action: proposed -> accepted or dropped, accepted -> done or dropped. done records the time and the target metric's baseline.",
        inputSchema: z.object({ project_id: z.string(), action_id: z.number().int(), status: z.enum(["accepted", "done", "dropped"]) }),
      },
      ({ project_id, action_id, status }) => attempt(() => actions.update(project_id, action_id, status)),
    )
  }

  server.registerTool(
    "brief_save",
    {
      description: "Store the weekly brief (markdown) of a project. period: ISO week like 2026-W46, default the current week.",
      inputSchema: z.object({ project_id: z.string(), period: z.string().optional(), markdown: z.string() }),
    },
    ({ project_id, period, markdown }) =>
      attempt(() => {
        if (!getProject(db, project_id)) throw new Error(`unknown project ${project_id}`)
        return actions.saveBrief(project_id, period ?? bucketOf("weekly", now()), markdown)
      }),
  )

  return server
}
