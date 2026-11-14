import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

// Append only. Each entry runs once, tracked by PRAGMA user_version.
const migrations = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    brand_names TEXT NOT NULL DEFAULT '[]',
    location TEXT NOT NULL,
    language TEXT NOT NULL,
    competitors TEXT NOT NULL DEFAULT '[]',
    seed_topics TEXT NOT NULL DEFAULT '[]',
    positioning TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE tracked_items (
    project_id TEXT NOT NULL REFERENCES projects(id),
    type TEXT NOT NULL CHECK (type IN ('keyword', 'prompt', 'url')),
    value TEXT NOT NULL,
    cluster TEXT,
    intent TEXT,
    PRIMARY KEY (project_id, type, value)
  );
  CREATE TABLE caps (
    scope TEXT PRIMARY KEY,
    usd REAL NOT NULL
  );
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    bucket TEXT NOT NULL,
    params_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('claimed', 'ok', 'failed')),
    claim_token TEXT,
    captured_at TEXT NOT NULL,
    payload TEXT,
    UNIQUE (project_id, kind, subject, bucket, params_hash)
  );
  CREATE TABLE spend (
    id INTEGER PRIMARY KEY,
    snapshot_id INTEGER,
    attempt INTEGER NOT NULL,
    project_id TEXT,
    kind TEXT NOT NULL,
    month TEXT NOT NULL,
    estimate_usd REAL NOT NULL,
    actual_usd REAL,
    at TEXT NOT NULL
  );
  CREATE INDEX spend_month ON spend (month, project_id);
  CREATE TRIGGER spend_no_delete BEFORE DELETE ON spend
    BEGIN SELECT RAISE(ABORT, 'spend is append-only'); END;
  CREATE TRIGGER spend_update_actual_only BEFORE UPDATE ON spend
    WHEN OLD.actual_usd IS NOT NULL
      OR NEW.id IS NOT OLD.id OR NEW.snapshot_id IS NOT OLD.snapshot_id OR NEW.attempt IS NOT OLD.attempt
      OR NEW.project_id IS NOT OLD.project_id OR NEW.kind IS NOT OLD.kind OR NEW.month IS NOT OLD.month
      OR NEW.estimate_usd IS NOT OLD.estimate_usd OR NEW.at IS NOT OLD.at
    BEGIN SELECT RAISE(ABORT, 'spend rows only accept actual_usd once'); END;
  `,
  `
  CREATE TABLE metrics (
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    key TEXT NOT NULL,
    date TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (project_id, kind, subject, key, date)
  );
  -- One row at the start and one at the end of every runDue(): the last tick, and the DataForSEO balance
  -- next to the settled ledger total for reconciliation. balance_usd is null when it could not be read.
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('start', 'end')),
    balance_usd REAL,
    ledger_usd REAL NOT NULL
  );
  `,
  `
  CREATE TABLE actions (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    rationale TEXT NOT NULL,
    evidence TEXT NOT NULL, -- JSON array of snapshot ids
    target_kind TEXT NOT NULL,
    target_subject TEXT NOT NULL,
    target_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'done', 'dropped')),
    baseline REAL,
    done_at TEXT
  );
  CREATE INDEX actions_project ON actions (project_id);
  CREATE TABLE briefs (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    period TEXT NOT NULL,
    markdown TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX briefs_project ON briefs (project_id, period);
  `,
]

export const openDb = (path: string): Database => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path, { strict: true })
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")
  migrate(db)
  return db
}

/** True when the file at `path` opens as a database whose migrations are all applied. Creates and changes nothing. */
export const dbHealthy = (path: string): boolean => {
  let db: Database | undefined
  try {
    db = new Database(path, { readwrite: true, create: false })
    const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number }
    return user_version === migrations.length
  } catch {
    return false
  } finally {
    db?.close()
  }
}

const migrate = (db: Database): void => {
  db.transaction(() => {
    const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number }
    for (let v = user_version; v < migrations.length; v++) db.run(migrations[v]!)
    db.run(`PRAGMA user_version = ${migrations.length}`)
  }).immediate()
}
