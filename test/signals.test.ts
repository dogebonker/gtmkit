import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vite-plus/test"
import { openDb } from "../src/db"
import { upsertProject } from "../src/projects"
import { collectors, createSignals } from "../src/signals"
import { bucketOf, weekStart } from "../src/signals/collector"
import { fakeDataForSEO, fakeWeb } from "./fake-provider"

process.env.GTMKIT_NOW = "2026-11-15T08:00:00.000Z"

const setup = (fakeOpts?: Parameters<typeof fakeDataForSEO>[0]) => {
  const db = openDb(":memory:")
  const fake = fakeDataForSEO(fakeOpts)
  const signals = createSignals(db, { dataforseo: fake.dataforseo })
  signals.setCap("global", 150)
  signals.setCap("default", 30)
  const project = upsertProject(db, { domain: "example.com", location: "United States", language: "English" })
  const ledger = () =>
    (db.query("SELECT coalesce(sum(coalesce(actual_usd, estimate_usd)), 0) AS t, count(*) AS n FROM spend").get() as {
      t: number
      n: number
    })
  return { db, fake, signals, project, ledger }
}

describe("signals.collect", () => {
  test("a repeat inside the freshness window returns the stored snapshot and adds no spend row", async () => {
    const { fake, signals, project, ledger } = setup()
    const first = await signals.collect(project.id, "keyword_gap", { subject: "https://www.rival.com/" }, false)
    expect(first.status).toBe("collected")
    expect(ledger().n).toBe(1)

    process.env.GTMKIT_NOW = "2026-11-20T08:00:00.000Z" // same 30-day bucket
    const again = await signals.collect(project.id, "keyword_gap", { subject: "rival.com" }, false)
    process.env.GTMKIT_NOW = "2026-11-15T08:00:00.000Z"

    expect(again.status).toBe("fresh")
    if (first.status === "collected" && again.status === "fresh") expect(again.snapshot.id).toBe(first.snapshot.id)
    expect(ledger().n).toBe(1)
    expect(fake.charges).toHaveLength(1)
  })

  test("dry run returns the estimate and makes no call", async () => {
    const { fake, signals, project, ledger } = setup()
    const r = await signals.collect(project.id, "competitor_keywords", { subject: "rival.com" }, true)
    expect(r).toEqual({ status: "estimate", kind: "competitor_keywords", subject: "rival.com", estimate_usd: 0.024, fresh: false })
    expect(fake.charges).toHaveLength(0)
    expect(ledger().n).toBe(0)
  })

  test("the ledger records the reported cost, at or under the estimate", async () => {
    const { db, fake, signals, project } = setup()
    await signals.collect(project.id, "keyword_ideas", { subject: "crm" }, false)
    const row = db.query("SELECT estimate_usd, actual_usd, attempt, month FROM spend").get() as Record<string, number>
    expect(row).toEqual({ estimate_usd: 0.024, actual_usd: fake.charges[0]!.usd, attempt: 1, month: "2026-11" })
  })

  test("a cap at $0 refuses, names the cap and makes no provider call", async () => {
    const { fake, signals, project, ledger } = setup()
    signals.setCap(project.id, 0)
    const r = await signals.collect(project.id, "keyword_ideas", { subject: "crm" }, false)
    expect(r.status).toBe("refused")
    if (r.status === "refused") expect(r.reason).toContain(`project cap for ${project.id} $0.0000`)
    expect(fake.charges).toHaveLength(0)
    expect(ledger().n).toBe(0)
  })

  test("the global cap counts every project's spend this month", async () => {
    const { db, fake, signals, project } = setup()
    signals.setCap("global", 0.03)
    const other = upsertProject(db, { domain: "other.com", location: "United States", language: "English" })
    expect((await signals.collect(other.id, "keyword_ideas", { subject: "a" }, false)).status).toBe("collected")
    const r = await signals.collect(project.id, "keyword_ideas", { subject: "b" }, false)
    expect(r.status).toBe("refused")
    if (r.status === "refused") expect(r.reason).toContain("global cap")
    expect(fake.charges).toHaveLength(1)
  })

  test("with no default cap or no global cap every collection is refused", async () => {
    const { db, fake, signals, project } = setup()
    signals.setCap(project.id, 10)
    db.run("DELETE FROM caps WHERE scope = 'default'")
    expect(await signals.collect(project.id, "keyword_ideas", { subject: "crm" }, false)).toEqual({
      status: "refused",
      reason: "no default cap is set. Run gtmkit budget",
    })
    signals.setCap("default", 30)
    db.run("DELETE FROM caps WHERE scope = 'global'")
    expect((await signals.collect(project.id, "keyword_ideas", { subject: "crm" }, false)).status).toBe("refused")
    expect(fake.charges).toHaveLength(0)
  })

  test("a reported cost above the estimate writes halt:<kind>, and that kind then refuses", async () => {
    const { fake, signals, project } = setup({ overcharge: 3 })
    expect((await signals.collect(project.id, "keyword_ideas", { subject: "crm" }, false)).status).toBe("collected")
    expect(signals.caps().map((c) => c.scope)).toContain("halt:keyword_ideas")
    const r = await signals.collect(project.id, "keyword_ideas", { subject: "other" }, false)
    expect(r.status).toBe("refused")
    if (r.status === "refused") expect(r.reason).toContain("halt:keyword_ideas")
    expect((await signals.collect(project.id, "keyword_gap", { subject: "rival.com" }, false)).status).toBe("collected")
    expect(fake.charges).toHaveLength(2)
    expect(signals.clearHalts()).toBe(2) // keyword_ideas and keyword_gap were both overcharged
  })

  test("a fresh foreign claim returns in progress; a claim older than 10 minutes is taken over", async () => {
    const { db, fake, signals, project, ledger } = setup()
    const slow = createSignals(db, {
      dataforseo: fakeDataForSEO({ delayMs: () => 50 }).dataforseo,
    })
    const pending = slow.collect(project.id, "keyword_ideas", { subject: "crm" }, false)
    await Bun.sleep(10)
    expect(await signals.collect(project.id, "keyword_ideas", { subject: "crm" }, false)).toEqual({
      status: "in_progress",
      kind: "keyword_ideas",
      subject: "crm",
    })
    expect((await pending).status).toBe("collected")

    // A claim left by a crashed process.
    db.run("UPDATE snapshots SET status = 'claimed', claim_token = 'dead'")
    process.env.GTMKIT_NOW = "2026-11-15T08:09:00.000Z"
    expect((await signals.collect(project.id, "keyword_ideas", { subject: "crm" }, false)).status).toBe("in_progress")
    process.env.GTMKIT_NOW = "2026-11-15T08:11:00.000Z"
    expect((await signals.collect(project.id, "keyword_ideas", { subject: "crm" }, false)).status).toBe("collected")
    process.env.GTMKIT_NOW = "2026-11-15T08:00:00.000Z"
    expect(db.query("SELECT attempt FROM spend ORDER BY id").all()).toEqual([{ attempt: 1 }, { attempt: 2 }])
    expect(fake.charges).toHaveLength(1)
    expect(ledger().n).toBe(2)
  })

  test("a completion that throws after the provider charged keeps the reported cost and the halt, marks the row failed, and does not throw", async () => {
    const { db, fake, signals, project } = setup({ overcharge: 3 })
    const ideas = collectors.get("keyword_ideas")!
    const extract = ideas.extract
    ideas.extract = () => {
      throw new Error("extract broke")
    }
    try {
      const r = await signals.collect(project.id, "keyword_ideas", { subject: "crm" }, false)
      expect(r).toMatchObject({ status: "failed", reason: expect.stringContaining("extract broke") })
    } finally {
      ideas.extract = extract
    }
    expect(db.query("SELECT actual_usd FROM spend").all()).toEqual([{ actual_usd: fake.charges[0]!.usd }])
    expect(signals.caps().map((c) => c.scope)).toContain("halt:keyword_ideas")
    expect(db.query("SELECT status FROM snapshots").all()).toEqual([{ status: "failed" }])
  })

  test("a result that fails decoding still records the reported cost and runs the halt check", async () => {
    const { db, fake, signals, project } = setup({ malformed: true, overcharge: 3 })
    const r = await signals.collect(project.id, "keyword_ideas", { subject: "crm" }, false)
    expect(r.status).toBe("failed")
    expect(db.query("SELECT actual_usd FROM spend").all()).toEqual([{ actual_usd: fake.charges[0]!.usd }])
    expect(signals.caps().map((c) => c.scope)).toContain("halt:keyword_ideas")
  })

  test("a reported cost the database is too busy to take is kept in a file and applied once by the next reconcile", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "gtmkit-busy-")), "gtmkit.db")
    const db = openDb(path)
    db.run("PRAGMA busy_timeout = 100") // the other writer holds the lock longer than this connection waits
    const fake = fakeDataForSEO({ overcharge: 3, delayMs: () => 50 })
    const signals = createSignals(db, { dataforseo: fake.dataforseo, web: fakeWeb({ round: 0 }).web })
    signals.setCap("global", 150)
    signals.setCap("default", 30)
    const project = upsertProject(db, { domain: "example.com", location: "United States", language: "English" })
    writeFileSync(`${path}.costs`, '{"spend_id":1,"kind":"keyw') // a line torn by a crash mid-append
    const pending = signals.collect(project.id, "keyword_ideas", { subject: "crm" }, false) // claimed, now calling
    const other = openDb(path)
    other.run("BEGIN IMMEDIATE")
    try {
      expect((await pending).status).toBe("failed")
    } finally {
      other.run("ROLLBACK")
    }
    expect((await signals.runDue()).start.bad_cost_lines).toBe(1) // skipped and counted; the next line is intact
    expect(db.query("SELECT actual_usd FROM spend WHERE kind = 'keyword_ideas'").all()).toEqual([{ actual_usd: fake.charges[0]!.usd }])
    expect(signals.caps().map((c) => c.scope)).toContain("halt:keyword_ideas")
    signals.clearHalts()
    await signals.runDue()
    expect(signals.caps().map((c) => c.scope)).not.toContain("halt:keyword_ideas")
  })

  test("spend rows cannot be deleted or rewritten", () => {
    const { db } = setup()
    db.run("INSERT INTO spend (attempt, kind, month, estimate_usd, at) VALUES (1, 'k', '2026-11', 0.1, 'x')")
    expect(() => db.run("DELETE FROM spend")).toThrow("append-only")
    expect(() => db.run("UPDATE spend SET estimate_usd = 0")).toThrow()
    db.run("UPDATE spend SET actual_usd = 0.05")
    expect(() => db.run("UPDATE spend SET actual_usd = 0.01")).toThrow()
  })
})

describe("buckets", () => {
  test("freshness kinds use floor(unix_day / days), weekly kinds the ISO week", () => {
    expect(bucketOf({ freshnessDays: 30 }, new Date("2026-11-15T08:00:00Z"))).toBe("692")
    expect(bucketOf("weekly", new Date("2026-11-15T08:00:00Z"))).toBe("2026-W46")
    expect(bucketOf("weekly", new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53")
    expect(bucketOf("weekly", new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01")
  })

  test("weekStart accepts only weeks that exist", () => {
    expect(weekStart("2026-W53").toISOString()).toBe("2026-12-28T00:00:00.000Z")
    for (const week of ["2025-W53", "2026-W00", "2026-W54"]) expect(() => weekStart(week), week).toThrow("ISO week")
  })
})

describe("projects", () => {
  test("tracked item limits: 200 keywords, 30 prompts, 20 URLs", () => {
    const { db, project } = setup()
    const many = (n: number) => Array.from({ length: n }, (_, i) => `item ${i}`)
    expect(() => upsertProject(db, { id: project.id, keywords: many(201).map((value) => ({ value })) })).toThrow("limit is 200")
    expect(() => upsertProject(db, { id: project.id, prompts: many(31) })).toThrow("limit is 30")
    expect(() => upsertProject(db, { id: project.id, urls: many(21) })).toThrow("limit is 20")
    const ok = upsertProject(db, { id: project.id, keywords: many(200).map((value) => ({ value, cluster: "c", intent: "i" })) })
    expect(ok.keywords).toHaveLength(200)
  })
})
