import type { Database } from "bun:sqlite"
import { now } from "../env"

export const LIMITS = { keyword: 200, prompt: 30, url: 20 } as const

// A project id is also a cap scope and part of a transcript file name: it must not name another scope or a path.
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface Keyword {
  value: string
  cluster: string | null
  intent: string | null
}

export interface Project {
  id: string
  domain: string
  brand_names: string[]
  location: string
  language: string
  competitors: string[]
  seed_topics: string[]
  positioning: string
  keywords: Keyword[]
  prompts: string[]
  urls: string[]
}

/** Fields left out keep their stored value. A tracked list, when given, replaces that list. */
export interface ProjectInput {
  id?: string
  domain?: string
  brand_names?: string[]
  location?: string
  language?: string
  competitors?: string[]
  seed_topics?: string[]
  positioning?: string
  keywords?: { value: string; cluster?: string | null; intent?: string | null }[]
  prompts?: string[]
  urls?: string[]
}

interface ProjectRow {
  id: string
  domain: string
  brand_names: string
  location: string
  language: string
  competitors: string
  seed_topics: string
  positioning: string
}

export const getProject = (db: Database, id: string): Project | null => {
  const row = db.query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | null
  if (!row) return null
  const items = db
    .query("SELECT type, value, cluster, intent FROM tracked_items WHERE project_id = ? ORDER BY rowid")
    .all(id) as { type: keyof typeof LIMITS; value: string; cluster: string | null; intent: string | null }[]
  return {
    id: row.id,
    domain: row.domain,
    brand_names: JSON.parse(row.brand_names),
    location: row.location,
    language: row.language,
    competitors: JSON.parse(row.competitors),
    seed_topics: JSON.parse(row.seed_topics),
    positioning: row.positioning,
    keywords: items.filter((i) => i.type === "keyword").map(({ value, cluster, intent }) => ({ value, cluster, intent })),
    prompts: items.filter((i) => i.type === "prompt").map((i) => i.value),
    urls: items.filter((i) => i.type === "url").map((i) => i.value),
  }
}

export const listProjectIds = (db: Database): string[] =>
  (db.query("SELECT id FROM projects ORDER BY created_at, id").all() as { id: string }[]).map((r) => r.id)

export const upsertProject = (db: Database, input: ProjectInput): Project => {
  if (input.id !== undefined && (!ID.test(input.id) || ["global", "default"].includes(input.id) || input.id.startsWith("halt"))) {
    throw new Error(
      `refused: project id ${JSON.stringify(input.id.slice(0, 80))} must be 1 to 64 of a-z, 0-9 and -, start with a letter or digit, and not be global, default or start with halt`,
    )
  }
  for (const [type, list] of [
    ["keyword", input.keywords],
    ["prompt", input.prompts],
    ["url", input.urls],
  ] as const) {
    if (list && list.length > LIMITS[type]) {
      throw new Error(`refused: ${list.length} ${type}s, the limit is ${LIMITS[type]} per project`)
    }
  }
  const at = now().toISOString()
  const id = input.id ?? crypto.randomUUID()
  db.transaction(() => {
    const existing = getProject(db, id)
    if (!existing) {
      if (!input.domain || !input.location || !input.language) {
        throw new Error("a new project needs domain, location and language")
      }
      db.query(
        `INSERT INTO projects (id, domain, location, language, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.domain, input.location, input.language, at, at)
    }
    const set = (column: string, value: string | undefined) => {
      if (value !== undefined) db.query(`UPDATE projects SET ${column} = ? WHERE id = ?`).run(value, id)
    }
    set("domain", input.domain)
    set("location", input.location)
    set("language", input.language)
    set("positioning", input.positioning)
    for (const column of ["brand_names", "competitors", "seed_topics"] as const) {
      set(column, input[column] && JSON.stringify(input[column]))
    }
    set("updated_at", at)
    const replace = (type: keyof typeof LIMITS, rows: Keyword[] | undefined) => {
      if (!rows) return
      db.query("DELETE FROM tracked_items WHERE project_id = ? AND type = ?").run(id, type)
      const insert = db.query(
        "INSERT OR REPLACE INTO tracked_items (project_id, type, value, cluster, intent) VALUES (?, ?, ?, ?, ?)",
      )
      for (const r of rows) insert.run(id, type, r.value, r.cluster, r.intent)
    }
    replace(
      "keyword",
      input.keywords?.map((k) => ({ value: k.value, cluster: k.cluster ?? null, intent: k.intent ?? null })),
    )
    replace("prompt", input.prompts?.map((value) => ({ value, cluster: null, intent: null })))
    replace("url", input.urls?.map((value) => ({ value, cluster: null, intent: null })))
  }).immediate()
  return getProject(db, id)!
}
