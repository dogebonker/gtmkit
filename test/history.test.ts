import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import type { Database } from "bun:sqlite"
import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vite-plus/test"
import { openDb } from "../src/db"
import { createServer } from "../src/edge/mcp/server"
import { upsertProject } from "../src/projects"
import { Effect } from "effect"
import { collectors, createSignals, type Providers } from "../src/signals"
import type { SearchConsole } from "../src/signals/google"
import { ProviderError } from "../src/signals/http"
import { PRICES } from "../src/signals/prices"
import { fakeDataForSEO, fakeSearchConsole, fakeWeb, type World } from "./fake-provider"

const WEEK1 = "2026-11-09T08:00:00.000Z" // Monday of 2026-W46
const WEEK1_LATER = "2026-11-12T08:00:00.000Z" // Thursday, same week
const WEEK2 = "2026-11-16T08:00:00.000Z" // Monday of 2026-W47
process.env.GTMKIT_NOW = WEEK1

const profile = {
  domain: "example.com",
  brand_names: ["Example"],
  location: "United States",
  language: "English",
  competitors: ["rival-one.com"],
  keywords: ["crm for freelancers", "simple crm", "freelance crm"].map((value) => ({ value, cluster: "crm", intent: "commercial" })),
  prompts: ["What is the best CRM for freelancers?"],
  urls: ["https://rival-one.com/pricing"],
}

const setup = (opts: Parameters<typeof fakeDataForSEO>[0] = {}, db: Database = openDb(":memory:")) => {
  process.env.GTMKIT_NOW = WEEK1
  const world: World = { round: 0 }
  const fake = fakeDataForSEO({ world, ...opts })
  const gsc = fakeSearchConsole(world)
  const web = fakeWeb(world)
  const providers: Providers = { dataforseo: fake.dataforseo, gsc: gsc.gsc, web: web.web }
  const signals = createSignals(db, providers)
  signals.setCap("global", 150)
  signals.setCap("default", 30)
  const project = upsertProject(db, profile)
  const spendRows = () => db.query("SELECT * FROM spend ORDER BY id").all() as Record<string, unknown>[]
  return { db, world, fake, gsc, web, providers, signals, project, spendRows }
}

/** Two weekly ticks: round 0 in 2026-W46, round 1 in 2026-W47. */
const twoWeeks = async (s: ReturnType<typeof setup>) => {
  process.env.GTMKIT_NOW = WEEK1
  await s.signals.runDue()
  s.world.round = 1
  process.env.GTMKIT_NOW = WEEK2
  await s.signals.runDue()
}

describe("runDue", () => {
  test("AC3: after a tick with no failures, a second tick in the same week makes no provider call", async () => {
    const s = setup()
    const first = await s.signals.runDue()
    expect(first.kinds.map((k) => [k.kind, k.collected, k.failed.length]).sort()).toEqual([
      ["ai_access", 1, 0],
      ["ai_visibility", 2, 0],
      ["gsc_performance", 1, 0],
      ["page_watch", 1, 0],
      ["serp_top30", 3, 0],
    ])
    expect(s.fake.charges).toHaveLength(5) // 3 SERP + 2 LLM answers
    const searchConsoleCalls = s.gsc.requests.length
    expect(searchConsoleCalls).toBe(2) // totals and per-query rows

    process.env.GTMKIT_NOW = WEEK1_LATER
    const second = await s.signals.runDue()
    process.env.GTMKIT_NOW = WEEK1

    expect(second.kinds).toEqual([])
    expect(s.fake.calls).toHaveLength(5)
    expect(s.gsc.requests).toHaveLength(searchConsoleCalls)
    expect(s.web.fetched).toHaveLength(3) // the watched page, robots.txt and llms.txt
    expect(s.spendRows().filter((r) => r.kind === "adjustment")).toEqual([]) // charges matched the ledger
  })

  test("AC4: a charge above the estimate with no reported cost makes the next runDue append an adjustment and halt", async () => {
    const s = setup({ overcharge: 3, reportCost: false })
    await s.signals.runDue() // baseline reading at the start; this run's own excess is caught at its end
    const ledger = () => s.spendRows().reduce((sum, r) => sum + Number(r.actual_usd ?? r.estimate_usd), 0)
    const charged = () => s.fake.charges.reduce((sum, c) => sum + c.usd, 0)
    expect(s.signals.caps().map((c) => c.scope)).toContain("halt:all")
    expect(ledger()).toBeCloseTo(charged(), 9)
    s.signals.clearHalts()

    // An interactive collection charged 3x its estimate and reported no cost: the ledger holds only the estimate.
    expect((await s.signals.collect(s.project.id, "keyword_volume", {}, false)).status).toBe("collected")
    expect(ledger()).toBeLessThan(charged())
    const callsBefore = s.fake.calls.length

    process.env.GTMKIT_NOW = WEEK2
    const r = await s.signals.runDue()
    process.env.GTMKIT_NOW = WEEK1

    const adjustments = s.spendRows().filter((row) => row.kind === "adjustment")
    expect(adjustments).toHaveLength(2)
    expect(adjustments[1]).toMatchObject({ project_id: null, snapshot_id: null, month: "2026-11" })
    expect(r.start.adjustment_usd).toBeCloseTo(s.fake.charges.at(-1)!.usd - 0.012 - 0.00012 * 3, 9)
    expect(ledger()).toBeCloseTo(charged(), 9)
    expect(s.signals.caps().map((c) => c.scope)).toContain("halt:all")
    expect(s.fake.calls.length).toBe(callsBefore) // the halt stopped every due DataForSEO kind
    expect(r.kinds.find((k) => k.kind === "serp_top30")?.failed[0]).toContain("halt:all")
  })

  test("a kind whose due set does not fit the caps is skipped whole and shows as zero coverage, not as changes", async () => {
    const s = setup()
    const keywords = Array.from({ length: 10 }, (_, i) => ({ value: `kw ${i}` }))
    upsertProject(s.db, { id: s.project.id, keywords })
    // ai_visibility needs up to 2 x $0.0206 and fits; it is charged $0.0092. serp_top30 then needs 10 x $0.006 = $0.06:
    // the set does not fit $0.05, though its first 6 calls would.
    s.signals.setCap(s.project.id, 0.05)
    const r = await s.signals.runDue()
    const serp = r.kinds.find((k) => k.kind === "serp_top30")!
    expect(serp.skipped).toContain("the due set of 10 needs up to $0.0600")
    expect(serp.collected).toBe(0)
    expect(s.fake.charges.filter((c) => c.path.includes("/serp/"))).toHaveLength(0)
    expect(s.fake.charges.filter((c) => c.path.includes("/llm_responses/"))).toHaveLength(2)

    const d = s.signals.digest(s.project.id)
    expect(d.kinds.serp_top30).toEqual({ coverage: { collected: 0, expected: 10 }, changes: [] })
    expect(d.kinds.ai_visibility!.coverage).toEqual({ collected: 2, expected: 2 })
  })

  test("a 5xx is retried as a new attempt with its own spend row", async () => {
    const s = setup({ httpStatus: (call, path) => (call === 1 && path.includes("/serp/") ? 500 : 200) })
    upsertProject(s.db, { id: s.project.id, keywords: [{ value: "crm" }], prompts: [] })
    const r = await s.signals.runDue()
    expect(r.kinds.find((k) => k.kind === "serp_top30")).toMatchObject({ collected: 1, failed: [] })
    const serpRows = s.spendRows().filter((row) => row.kind === "serp_top30")
    expect(serpRows.map((row) => [row.snapshot_id, row.attempt, row.actual_usd])).toEqual([
      [serpRows[0]!.snapshot_id, 1, null],
      [serpRows[0]!.snapshot_id, 2, 0.006],
    ])
  })

  test("a timeout is not retried", async () => {
    const s = setup({ timeoutMs: 50, delayMs: () => 500 })
    upsertProject(s.db, { id: s.project.id, keywords: [{ value: "crm" }], prompts: [] })
    const r = await s.signals.runDue()
    const serp = r.kinds.find((k) => k.kind === "serp_top30")!
    expect(serp.failed).toHaveLength(1)
    expect(serp.failed[0]).toContain("timed out")
    expect(s.fake.calls.filter((p) => p.includes("/serp/"))).toHaveLength(1)
    expect(s.spendRows().filter((row) => row.kind === "serp_top30")).toMatchObject([{ attempt: 1, actual_usd: null, estimate_usd: 0.006 }])
  })

  test("a collection that throws does not abort runDue: the end reconcile still runs", async () => {
    const s = setup()
    const serp = collectors.get("serp_top30")!
    const fetch = serp.fetch
    serp.fetch = () => {
      throw new Error("collector broke")
    }
    let r: Awaited<ReturnType<typeof s.signals.runDue>>
    try {
      r = await s.signals.runDue()
    } finally {
      serp.fetch = fetch
    }
    expect(r.kinds.find((k) => k.kind === "serp_top30")).toMatchObject({ collected: 0, failed: Array(3).fill(expect.stringContaining("collector broke")) })
    expect(r.kinds.find((k) => k.kind === "ai_visibility")?.collected).toBe(2)
    expect(s.db.query("SELECT phase FROM runs ORDER BY id").all()).toEqual([{ phase: "start" }, { phase: "end" }])
  })

  test("a collection in flight across a tick's reconciliation is not taken for an excess", async () => {
    const s = setup({ delayMs: () => 100 }) // charged at once, answered 100 ms later
    upsertProject(s.db, { id: s.project.id, keywords: [], prompts: [], urls: [] })
    await s.signals.runDue() // the baseline balance reading
    const pending = s.signals.collect(s.project.id, "keyword_ideas", { subject: "crm" }, false)
    await Bun.sleep(20)
    await s.signals.runDue() // the call is charged and its row still claimed
    expect((await pending).status).toBe("collected") // settled below its estimate
    await s.signals.runDue()
    expect(s.signals.caps().map((c) => c.scope)).not.toContain("halt:all")
    expect(s.spendRows().filter((r) => r.kind === "adjustment")).toEqual([])
  })

  test("a claim left after a charge stops masking once older than the takeover window: the next overcharge halts", async () => {
    process.env.GTMKIT_NOW = WEEK1
    const db = openDb(":memory:")
    const fakeOpts = { reportCost: false, overcharge: 1 }
    const fake = fakeDataForSEO(fakeOpts)
    const signals = createSignals(db, { dataforseo: fake.dataforseo, web: fakeWeb({ round: 0 }).web })
    signals.setCap("global", 150)
    signals.setCap("default", 30)
    const project = upsertProject(db, { domain: "example.com", location: "United States", language: "English" })
    await signals.runDue() // the baseline balance reading
    expect((await signals.collect(project.id, "keyword_ideas", { subject: "stale" }, false)).status).toBe("collected")
    db.run("UPDATE snapshots SET status = 'claimed' WHERE subject = 'stale'") // killed after the charge, never retried
    await signals.runDue() // still in flight as far as anyone can tell
    process.env.GTMKIT_NOW = "2026-11-09T08:11:00.000Z" // past the 10-minute takeover window
    await signals.runDue()
    fakeOpts.overcharge = 3 // a wrong price table, and no cost reported
    expect((await signals.collect(project.id, "keyword_ideas", { subject: "w0" }, false)).status).toBe("collected")
    const r = await signals.runDue()
    process.env.GTMKIT_NOW = WEEK1
    expect(r.start.adjustment_usd).toBeCloseTo(fake.charges.at(-1)!.usd - 0.024, 9)
    expect(signals.caps().map((c) => c.scope)).toContain("halt:all")
  })

  test.each([
    ["below", 1, false],
    ["above", 3, true],
  ])("a call that completes after reconcile expired its claim: a cost %s the estimate is kept only if it raises it", async (_, overcharge, halts) => {
    process.env.GTMKIT_NOW = WEEK1
    const db = openDb(":memory:")
    const fake = fakeDataForSEO({ overcharge, delayMs: () => 100 })
    const signals = createSignals(db, { dataforseo: fake.dataforseo, web: fakeWeb({ round: 0 }).web })
    signals.setCap("global", 150)
    signals.setCap("default", 30)
    const project = upsertProject(db, { domain: "example.com", location: "United States", language: "English" })
    await signals.runDue() // the baseline balance reading
    const pending = signals.collect(project.id, "keyword_ideas", { subject: "slow" }, false) // charged at once
    await Bun.sleep(20)
    process.env.GTMKIT_NOW = "2026-11-09T08:11:00.000Z" // the laptop slept past the takeover window
    await signals.runDue() // expires the claim and counts the call at its estimate
    expect((await pending).status).toBe("failed") // the late result is discarded
    await signals.runDue()
    process.env.GTMKIT_NOW = WEEK1
    const charged = fake.charges[0]!.usd
    expect(db.query("SELECT actual_usd FROM spend WHERE kind = 'keyword_ideas'").all()).toEqual([{ actual_usd: halts ? charged : null }])
    expect(db.query("SELECT status FROM snapshots WHERE kind = 'keyword_ideas'").all()).toEqual([{ status: "failed" }])
    // Below: no false excess. Above: a real one, which the reading at 08:11 already caught before the cost arrived.
    const scopes = signals.caps().map((c) => c.scope)
    expect(scopes.includes("halt:all")).toBe(halts)
    expect(scopes.includes("halt:keyword_ideas")).toBe(halts)
  })

  test("editing data that is stored but not sent mid-week buys nothing again", async () => {
    const s = setup()
    await s.signals.runDue()
    const calls = s.fake.calls.length
    upsertProject(s.db, { id: s.project.id, competitors: ["rival-two.com"], brand_names: ["Example", "Ex"] })
    process.env.GTMKIT_NOW = WEEK1_LATER
    const second = await s.signals.runDue()
    process.env.GTMKIT_NOW = WEEK1
    expect(second.kinds).toEqual([])
    expect(s.fake.calls).toHaveLength(calls)
  })

  test("interactive calls are never retried", async () => {
    const s = setup({ httpStatus: () => 503 })
    const r = await s.signals.collect(s.project.id, "serp_top30", { subject: "crm" }, false)
    expect(r).toMatchObject({ status: "failed", retryable: true })
    expect(s.fake.calls).toHaveLength(1)
    expect(s.spendRows()).toHaveLength(1)
  })
})

describe("digest", () => {
  test("AC5: two weeks give Search Console changes, a new top-30 competitor, an AI-visibility change, a page diff and coverage, in one call under 500 ms", async () => {
    const s = setup()
    await twoWeeks(s)

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await createServer(s.db, s.providers).connect(serverSide)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(clientSide)
    const started = performance.now()
    const res = (await client.callTool({ name: "digest", arguments: { project_id: s.project.id, period: "2026-W47" } })) as {
      content: { text: string }[]
      isError?: boolean
    }
    const elapsed = performance.now() - started
    expect(res.isError).toBeFalsy()
    const body = JSON.parse(res.content[0]!.text) as {
      kinds: Record<string, { coverage: { collected: number; expected: number }; changes: { magnitude: number; untrusted_change: string }[] }>
    }
    const changes = (kind: string) => body.kinds[kind]!.changes.map((c) => c.untrusted_change).join("\n")

    expect(changes("gsc_performance")).toContain("clicks 50 -> 80")
    expect(changes("gsc_performance")).toContain('new query \\"freelance invoicing crm\\"')
    expect(changes("serp_top30")).toContain("newcomer.com entered the top 30")
    expect(changes("ai_visibility")).toContain("now mentions the brand")
    expect(changes("ai_visibility")).toContain("now cites example.com")
    expect(changes("page_watch")).toContain("Team plan $30")
    expect(changes("ai_access")).toContain("GPTBot is now allowed")
    expect(changes("ai_access")).toContain("ClaudeBot is now blocked")
    expect(changes("ai_access")).toContain("llms.txt appeared")
    for (const kind of ["gsc_performance", "serp_top30", "ai_visibility", "page_watch", "ai_access"]) {
      expect(body.kinds[kind]!.coverage.collected).toBe(body.kinds[kind]!.coverage.expected)
      const magnitudes = body.kinds[kind]!.changes.map((c) => c.magnitude)
      expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a))
    }
    expect(body.kinds.serp_top30!.coverage).toEqual({ collected: 3, expected: 3 })
    expect(body.kinds.keyword_gap!.coverage).toEqual({ collected: 0, expected: 1 })
    expect(elapsed).toBeLessThan(500)
    await client.close()
  })

  test("the first week has coverage but no changes: missing earlier data is unknown", async () => {
    const s = setup()
    await s.signals.runDue()
    // keyword_gap's diff against nothing would list every row as new: digest must not call it without earlier data.
    expect((await s.signals.collect(s.project.id, "keyword_gap", { subject: "rival-one.com" }, false)).status).toBe("collected")
    const d = s.signals.digest(s.project.id)
    expect(d.period).toBe("2026-W46")
    expect(d.kinds.keyword_gap).toEqual({ coverage: { collected: 1, expected: 1 }, changes: [] })
    expect(d.kinds.serp_top30).toEqual({ coverage: { collected: 3, expected: 3 }, changes: [] })
    expect(d.kinds.page_watch!.changes).toEqual([])
  })
})

describe("coverage and missing data", () => {
  test("a freshness kind's subject counts as covered while its snapshot's bucket is current", async () => {
    const s = setup()
    expect((await s.signals.collect(s.project.id, "keyword_gap", { subject: "rival-one.com" }, false)).status).toBe("collected")
    process.env.GTMKIT_NOW = "2026-11-23T08:00:00.000Z" // 2026-W48, the same 30-day bucket
    const d = s.signals.digest(s.project.id)
    const status = s.signals.status()
    process.env.GTMKIT_NOW = WEEK1
    expect(d.kinds.keyword_gap!.coverage).toEqual({ collected: 1, expected: 1 })
    expect(status.projects[0]!.coverage.keyword_gap).toEqual({ collected: 1, expected: 1 })
  })

  test("status reads coverage without building a digest", async () => {
    const s = setup()
    await twoWeeks(s)
    const serp = collectors.get("serp_top30")!
    const diff = serp.diff
    serp.diff = () => {
      throw new Error("diff called")
    }
    try {
      expect(s.signals.status().projects[0]!.coverage.serp_top30).toEqual({ collected: 3, expected: 3 })
    } finally {
      serp.diff = diff
      process.env.GTMKIT_NOW = WEEK1
    }
  })

  test("missing data is not a change: a newly tracked keyword, a null backlink count, an empty AI answer", () => {
    const diff = (kind: string, prev: unknown, cur: unknown) => collectors.get(kind)!.diff(prev, cur)
    const volumes = (rows: [string, number | null][]) => ({
      date: "2026-11-09",
      items: rows.map(([keyword, search_volume]) => ({ keyword, search_volume, difficulty: null, cpc: null })),
    })
    expect(diff("keyword_volume", volumes([["a", 10], ["b", null]]), volumes([["a", 10], ["b", 40], ["c", 50]]))).toEqual([])
    expect(diff("keyword_volume", volumes([["a", 10]]), volumes([["a", 20]])).map((c) => c.summary)).toEqual(["volume 10 -> 20"])

    const links = (referring_domains: number | null, backlinks: number | null) => ({
      date: "2026-11-09",
      target: "example.com",
      items: [{ referring_domains, backlinks, referring_main_domains: null, rank: null, broken_backlinks: null }],
    })
    expect(diff("backlinks_summary", links(null, 1000), links(100, 1000))).toEqual([])
    expect(diff("backlinks_summary", links(100, null), links(120, 900)).map((c) => c.magnitude)).toEqual([20])

    const answer = (text: string) => ({
      date: "2026-11-09",
      engine: "chatgpt",
      prompt: "best crm",
      brands: ["Example"],
      domain: "example.com",
      items: [{ answer: text, sources: [] }],
    })
    expect(diff("ai_visibility", answer("Example is good."), answer(""))).toEqual([])
    expect(diff("ai_visibility", answer(""), answer("Example is good."))).toEqual([])
  })
})

describe("metrics", () => {
  test("AC8: rebuild-metrics on a copy of the database reproduces the metrics table exactly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gtmkit-ac8-"))
    const s = setup({}, openDb(join(dir, "gtmkit.db")))
    await twoWeeks(s)
    expect((await s.signals.collect(s.project.id, "keyword_volume", {}, false)).status).toBe("collected")
    const all = (db: Database) => db.query("SELECT * FROM metrics ORDER BY project_id, kind, subject, key, date").all()
    const original = all(s.db)
    const keys = new Set((original as { key: string }[]).map((m) => m.key))
    for (const key of [
      "clicks",
      "impressions",
      "position",
      "position:example.com",
      "position:rival-one.com",
      "ai_overview",
      "ai_overview_cited",
      "ai_overview_cited:rival-one.com",
      "mentioned",
      "cited",
      "mentioned:rival-one.com",
      "cited:rival-one.com",
      "allowed:GPTBot",
      "llms_txt",
      "changed_chars",
      "volume",
      "difficulty",
    ]) {
      expect(keys).toContain(key)
    }

    const copyHome = mkdtempSync(join(tmpdir(), "gtmkit-ac8-copy-"))
    s.db.run(`VACUUM INTO '${join(copyHome, "gtmkit.db")}'`)
    const copy = openDb(join(copyHome, "gtmkit.db"))
    copy.run("UPDATE metrics SET value = -1")
    copy.run("DELETE FROM metrics WHERE kind = 'serp_top30'")
    copy.close()

    const r = Bun.spawnSync([process.execPath, "src/edge/cli/main.ts", "rebuild-metrics"], {
      env: { PATH: process.env.PATH ?? "", GTMKIT_HOME: copyHome },
    })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    expect(all(openDb(join(copyHome, "gtmkit.db")))).toEqual(original)
  })

  test("keyword_volume stores volume and difficulty from one Labs keyword_overview call", async () => {
    const s = setup()
    const r = await s.signals.collect(s.project.id, "keyword_volume", {}, false)
    expect(r.status).toBe("collected")
    expect(s.fake.calls).toEqual(["/v3/dataforseo_labs/google/keyword_overview/live"])
    expect(s.spendRows()[0]).toMatchObject({ estimate_usd: 0.012 + 0.00012 * 3, actual_usd: 0.012 + 0.00012 * 3 })
    expect(s.db.query("SELECT key, value FROM metrics WHERE subject = 'simple crm' ORDER BY key").all()).toEqual([
      { key: "difficulty", value: 12 },
      { key: "volume", value: 300 },
    ])
  })
})

describe("Search Console", () => {
  test("a service account key and an OAuth refresh token both authorise; the run fetches the 7 days ending 3 days before it", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    })
    const world = { round: 0 }
    for (const fake of [
      fakeSearchConsole(world, { service_account: { client_email: "sa@p.iam.gserviceaccount.com", private_key: privateKey } }, publicKey),
      fakeSearchConsole(world),
    ]) {
      const db = openDb(":memory:")
      const signals = createSignals(db, { dataforseo: null, gsc: fake.gsc })
      signals.setCap("global", 150)
      signals.setCap("default", 30)
      const project = upsertProject(db, profile)
      const r = await signals.collect(project.id, "gsc_performance", {}, false)
      expect(r.status).toBe("collected")
      expect(fake.tokens).toHaveLength(1)
      expect(fake.requests[0]!.url).toBe(
        "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query",
      )
      expect(fake.requests.map((q) => q.body)).toEqual([
        { startDate: "2026-10-31", endDate: "2026-11-06", type: "web" },
        { startDate: "2026-10-31", endDate: "2026-11-06", type: "web", dimensions: ["query"], rowLimit: 1000 },
      ])
    }
  })

  test("the site total has its own subject, which a query equal to the domain cannot overwrite", async () => {
    const gsc: SearchConsole = (_site, body) =>
      Effect.succeed(
        body.dimensions
          ? [{ keys: ["example.com"], clicks: 3, impressions: 30, ctr: 0.1, position: 1.5 }]
          : [{ keys: [], clicks: 90, impressions: 900, ctr: 0.1, position: 4 }],
      )
    const db = openDb(":memory:")
    const signals = createSignals(db, { dataforseo: null, gsc })
    signals.setCap("global", 150)
    signals.setCap("default", 30)
    const project = upsertProject(db, profile)
    expect((await signals.collect(project.id, "gsc_performance", {}, false)).status).toBe("collected")
    expect(signals.metrics(project.id, "gsc_performance", { key: "clicks" }).map((m) => [m.subject, m.value])).toEqual([
      ["TOTAL", 90],
      ["example.com", 3],
    ])
  })

  test("without Google credentials gsc_performance is refused before any spend row", async () => {
    const db = openDb(":memory:")
    const signals = createSignals(db, { dataforseo: null })
    signals.setCap("global", 150)
    signals.setCap("default", 30)
    const project = upsertProject(db, profile)
    const r = await signals.collect(project.id, "gsc_performance", {}, false)
    expect(r).toMatchObject({ status: "refused", reason: expect.stringContaining("no Search Console credentials") })
    expect(db.query("SELECT count(*) AS n FROM spend").get()).toEqual({ n: 0 })
  })
})

describe("site_audit and backlinks_summary", () => {
  const audits = (s: ReturnType<typeof setup>) => s.fake.calls.filter((p) => p === "/v3/on_page/instant_pages")

  test("AC13: site_audit over a fixture sitemap stores per-page issues, at most 100 URLs, one snapshot each", async () => {
    const s = setup()
    s.world.pages = 120
    const dry = await s.signals.collect(s.project.id, "site_audit", {}, true)
    expect(dry).toMatchObject({ status: "set", kind: "site_audit", dry_run: true, due: 100, collected: 0 })
    if (dry.status === "set") expect(dry.estimate_usd).toBeCloseTo(100 * 0.00015, 9)
    expect(audits(s)).toHaveLength(0)

    const r = await s.signals.collect(s.project.id, "site_audit", {}, false)
    expect(r).toMatchObject({ status: "set", dry_run: false, due: 100, collected: 100, failed: [] })
    expect(audits(s)).toHaveLength(100)
    expect(s.web.fetched).toContain("https://example.com/sitemap-2.xml") // the index was followed
    const snapshots = s.signals.query(s.project.id, "site_audit")
    expect(new Set(snapshots.map((x) => x.subject)).size).toBe(100)
    expect(snapshots.map((x) => x.subject)).toContain("https://example.com/p/0?a=1&b=2")
    expect(snapshots.map((x) => x.subject)).not.toContain("https://elsewhere.org/p") // not the project's site
    const page = s.signals.query(s.project.id, "site_audit", "https://example.com/p/1")[0]!
    expect(page.payload).toMatchObject({ items: [{ url: "https://example.com/p/1", status_code: 200, issues: ["no_h1_tag"] }] })
    expect(s.signals.metrics(s.project.id, "site_audit", { key: "issues" })).toHaveLength(100)
    expect(s.signals.metrics(s.project.id, "site_audit", { subject: "https://example.com/p/1" })).toEqual([
      { subject: "https://example.com/p/1", key: "issues", date: "2026-11-09", value: 1 },
    ])

    // Inside the 7-day window every page is fresh: no call, no spend.
    const spendRows = s.spendRows().length
    expect(await s.signals.collect(s.project.id, "site_audit", {}, false)).toMatchObject({ due: 0, collected: 0 })
    expect(audits(s)).toHaveLength(100)
    expect(s.spendRows()).toHaveLength(spendRows)
  })

  test("site_audit refuses the whole set when it does not fit the cap, and makes no call", async () => {
    const s = setup()
    s.world.pages = 120
    s.signals.setCap(s.project.id, 0.01)
    const r = await s.signals.collect(s.project.id, "site_audit", {}, false)
    expect(r).toMatchObject({ status: "refused", reason: expect.stringContaining("the due set of 100 needs up to $0.0150") })
    expect(audits(s)).toHaveLength(0)
    expect(s.spendRows()).toHaveLength(0)
    expect((await s.signals.collect(s.project.id, "site_audit", { subject: "https://elsewhere.org/p" }, false)).status).toBe("refused")
  })

  test("backlinks_summary stores referring_domains and backlinks for the project and each competitor", async () => {
    const s = setup()
    for (const subject of [undefined, "rival-one.com"]) {
      expect((await s.signals.collect(s.project.id, "backlinks_summary", { subject }, false)).status).toBe("collected")
    }
    expect(s.fake.calls).toEqual(["/v3/backlinks/summary/live", "/v3/backlinks/summary/live"])
    for (const row of s.spendRows()) {
      expect(row.estimate_usd).toBeCloseTo(0.024036, 9)
      expect(row.actual_usd).toBeCloseTo(0.024036, 9)
    }
    expect(s.signals.metrics(s.project.id, "backlinks_summary").map((m) => [m.subject, m.key, m.value])).toEqual([
      ["example.com", "backlinks", 1000],
      ["example.com", "referring_domains", 100],
      ["rival-one.com", "backlinks", 1000],
      ["rival-one.com", "referring_domains", 100],
    ])
  })

  test("both kinds appear in digest with their changes and coverage", async () => {
    const s = setup()
    const collectBoth = async () => {
      expect((await s.signals.collect(s.project.id, "site_audit", {}, false)).status).toBe("set")
      for (const subject of ["example.com", "rival-one.com"]) {
        expect((await s.signals.collect(s.project.id, "backlinks_summary", { subject }, false)).status).toBe("collected")
      }
    }
    await collectBoth()
    s.world.round = 1
    process.env.GTMKIT_NOW = "2026-12-08T08:00:00.000Z" // 2026-W50, a new 7-day and 30-day bucket
    await collectBoth()
    const d = s.signals.digest(s.project.id)
    process.env.GTMKIT_NOW = WEEK1

    expect(d.period).toBe("2026-W50")
    expect(d.kinds.backlinks_summary!.coverage).toEqual({ collected: 2, expected: 2 })
    expect(d.kinds.backlinks_summary!.changes.map((c) => c.summary)).toContain(
      "example.com: referring domains 100 -> 112, backlinks 1000 -> 1250",
    )
    const audit = d.kinds.site_audit!.changes
    expect(audit).toHaveLength(3)
    expect(audit[0]!.summary).toMatch(/^https:\/\/example\.com\/p\/\S+: issues 1 -> 2, new: title_too_long$/)
    expect(audit[0]!.evidence).toHaveLength(2)
  })
})

describe("GEO", () => {
  const PROMPT = profile.prompts[0]!
  const values = (s: ReturnType<typeof setup>, kind: string, subject: string, key: string) =>
    s.signals.metrics(s.project.id, kind, { subject, key }).map((m) => m.value)

  test("ai_visibility records mentioned and cited for each competitor next to the project's own", async () => {
    const s = setup()
    await s.signals.runDue() // "Try Rival One or a spreadsheet.", sourced from rival-one.com/blog
    const subject = `chatgpt: ${PROMPT}`
    expect(Object.fromEntries(s.signals.metrics(s.project.id, "ai_visibility", { subject }).map((m) => [m.key, m.value]))).toEqual({
      cited: 0,
      "cited:rival-one.com": 1,
      mentioned: 0,
      "mentioned:rival-one.com": 1,
    })
  })

  test("a competitor is mentioned when the first label of its domain is a whole word, a hyphen matching a space or nothing", () => {
    const extract = collectors.get("ai_visibility")!.extract
    const mentioned = (answer: string) =>
      extract({ date: "2026-11-09", engine: "chatgpt", prompt: "p", brands: ["Example"], domain: "example.com", competitors: ["rival-one.com"], items: [{ answer, sources: [] }] }, null)
        .find((m) => m.key === "mentioned:rival-one.com")!.value
    expect(["Rival One", "rival-one.com", "RivalOne", "try RIVAL-ONE."].map(mentioned)).toEqual([1, 1, 1, 1])
    expect(["Rivalry one", "rival-ones", "a rival"].map(mentioned)).toEqual([0, 0, 0])
    // A competitor whose first label is empty is never mentioned.
    const empty = extract({ date: "2026-11-09", engine: "chatgpt", prompt: "p", brands: [], domain: "example.com", competitors: [".com"], items: [{ answer: "a . com - x", sources: [] }] }, null)
    expect(empty.find((m) => m.key === "mentioned:.com")!.value).toBe(0)
  })

  test("diff says when a competitor gains or loses a mention or citation, ranked below the project's own changes", () => {
    const diff = collectors.get("ai_visibility")!.diff
    const answer = (text: string, sources: string[]) => ({
      date: "2026-11-09",
      engine: "chatgpt",
      prompt: "best crm",
      brands: ["Example"],
      domain: "example.com",
      competitors: ["rival-one.com"],
      items: [{ answer: text, sources }],
    })
    const summaries = (a: unknown, b: unknown) => diff(a, b).map((c) => c.summary)
    const magnitudes = (a: unknown, b: unknown) => diff(a, b).map((c) => c.magnitude)
    expect(summaries(answer("Try a spreadsheet.", []), answer("Try Rival One.", ["https://www.rival-one.com/x"]))).toEqual([
      'chatgpt now mentions competitor rival-one.com for "best crm"; the brand is still not mentioned',
      'chatgpt now cites competitor rival-one.com for "best crm"; example.com is still not cited',
    ])
    expect(summaries(answer("Rival One or Example.", []), answer("Example.", []))).toEqual([
      'chatgpt no longer mentions competitor rival-one.com for "best crm"; the brand is still mentioned',
    ])
    // The project moved too: both are reported, the competitor's change below the project's own.
    expect(summaries(answer("Example.", []), answer("Rival One.", []))).toEqual([
      'chatgpt no longer mentions the brand for "best crm"',
      'chatgpt now mentions competitor rival-one.com for "best crm"; the brand is no longer mentioned',
    ])
    expect(magnitudes(answer("Example.", []), answer("Rival One.", []))).toEqual([1, 0.5])
  })

  test("the weekly run asks ChatGPT and Perplexity; all four engines are collectable on demand, priced per engine", async () => {
    const s = setup()
    await s.signals.runDue()
    expect(s.signals.query(s.project.id, "ai_visibility").map((x) => x.subject).sort()).toEqual(["chatgpt", "perplexity"].map((e) => `${e}: ${PROMPT}`))
    for (const engine of ["gemini", "claude"]) {
      expect((await s.signals.collect(s.project.id, "ai_visibility", { subject: `${engine}: ${PROMPT}` }, false)).status).toBe("collected")
    }
    const llm = s.fake.tasks.filter((t) => t.path.endsWith("/llm_responses/live"))
    const field = (t: (typeof llm)[number], k: string) => t.task[k] ?? null
    expect(
      llm.map((t) => [t.path, t.task.model_name, field(t, "web_search"), field(t, "max_output_tokens"), field(t, "use_reasoning")]).sort(),
    ).toEqual([
      ["/v3/ai_optimization/chat_gpt/llm_responses/live", "gpt-4.1-mini", true, 2048, null],
      ["/v3/ai_optimization/claude/llm_responses/live", "claude-haiku-4-5", true, 2048, false],
      ["/v3/ai_optimization/gemini/llm_responses/live", "gemini-2.5-flash", true, 2048, false],
      ["/v3/ai_optimization/perplexity/llm_responses/live", "sonar", null, 2048, null],
    ])
    const estimates = s.spendRows().filter((r) => r.kind === "ai_visibility").map((r) => r.estimate_usd as number)
    expect(estimates.sort((a, b) => a - b)).toEqual(
      [PRICES.llmModelMax.chatgpt, PRICES.llmModelMax.perplexity, PRICES.llmModelMax.gemini, PRICES.llmModelMax.claude]
        .map((m) => PRICES.llmTask + m)
        .sort((a, b) => a - b),
    )
  })

  test("Gemini's sources are the annotations' direct_url, not the Vertex AI redirect", async () => {
    const s = setup()
    const gemini = async () =>
      expect((await s.signals.collect(s.project.id, "ai_visibility", { subject: `gemini: ${PROMPT}` }, false)).status).toBe("collected")
    await gemini()
    s.world.round = 1 // the answer cites example.com
    process.env.GTMKIT_NOW = WEEK2
    await gemini()
    process.env.GTMKIT_NOW = WEEK1
    expect(values(s, "ai_visibility", `gemini: ${PROMPT}`, "cited")).toEqual([0, 1])
  })

  test("serp_top30 records AI Overview presence and whether it cites the project and each competitor, without the billed async option", async () => {
    const s = setup()
    await twoWeeks(s)
    process.env.GTMKIT_NOW = WEEK1
    const kw = "crm for freelancers"
    expect(values(s, "serp_top30", kw, "ai_overview")).toEqual([0, 1])
    expect(values(s, "serp_top30", kw, "ai_overview_cited")).toEqual([0, 1]) // in an element's references
    expect(values(s, "serp_top30", kw, "ai_overview_cited:rival-one.com")).toEqual([0, 1]) // in the item's references
    for (const t of s.fake.tasks.filter((x) => x.path.includes("/serp/"))) expect(t.task).not.toHaveProperty("load_async_ai_overview")

    // A tracked domain past the 20 stored references still counts as cited, and each stored domain is at most 253 chars.
    const refs = [...Array.from({ length: 24 }, (_, i) => ({ domain: `ref${i}.com` })), { domain: "www.rival-one.com" }, { domain: `${"x".repeat(5000)}.com` }]
    const serp = collectors.get("serp_top30")!
    const overviewOf = async (references: unknown[]) => {
      const answer = (_path: string, _task: Record<string, unknown>, decode: (r: unknown) => Effect.Effect<unknown, { message: string }>) =>
        Effect.map(decode([{ items: [{ type: "ai_overview", references, items: null }] }]), (result) => ({ result, costUsd: 0 }))
      const params = { keyword: kw, location_name: "United States", language_name: "English", depth: 30, keep: { tracked: ["example.com", "rival-one.com"] } }
      const { payload } = await Effect.runPromise(serp.fetch(params, Object.assign(answer, { balance: () => Effect.succeed(0) }) as never))
      return { payload, references: (payload as { ai_overview: { references: string[] } }).ai_overview.references }
    }
    const cut = await overviewOf(refs)
    expect(cut.references).toHaveLength(20)
    expect(Object.fromEntries(serp.extract(cut.payload, null).map((m) => [m.key, m.value]))).toMatchObject({
      ai_overview: 1,
      ai_overview_cited: 0,
      "ai_overview_cited:rival-one.com": 1,
    })
    expect((await overviewOf(refs.slice(-1))).references[0]!.length).toBe(253)

    // A payload stored before AI Overview tracking has no ai_overview field: no AI Overview metric, not a 0.
    const old = { date: "2026-11-02", keyword: kw, tracked: ["example.com"], items: [{ rank: 1, domain: "example.com", url: null, title: null }] }
    expect(collectors.get("serp_top30")!.extract(old, null).map((m) => m.key)).toEqual(["position:example.com"])
  })

  test("ai_access reads robots.txt and llms.txt of the project domain: a 404 is data, a blocked bot is 0", async () => {
    const s = setup()
    const r = await s.signals.collect(s.project.id, "ai_access", {}, false)
    expect(r.status).toBe("collected")
    expect(s.web.fetched).toEqual(["https://example.com/robots.txt", "https://example.com/llms.txt"])
    expect(Object.fromEntries(s.signals.metrics(s.project.id, "ai_access").map((m) => [m.key, m.value]))).toEqual({
      "allowed:ChatGPT-User": 1,
      "allowed:ClaudeBot": 1,
      "allowed:GPTBot": 0,
      "allowed:Google-Extended": 1,
      "allowed:OAI-SearchBot": 1,
      "allowed:PerplexityBot": 1,
      llms_txt: 0,
    })
    const [snapshot] = s.signals.query(s.project.id, "ai_access")
    expect(snapshot!.subject).toBe("example.com")
    expect((snapshot!.payload as { items: { file: string; found: boolean }[] }).items.map((i) => [i.file, i.found])).toEqual([
      ["robots.txt", true],
      ["llms.txt", false],
    ])
  })

  test("robots.txt rules: the agent's own group, else the * group, longest match for /; a missing file allows every bot", () => {
    const extract = collectors.get("ai_access")!.extract
    const allowed = (robots: string | null, llms: string | null = null) =>
      Object.fromEntries(
        extract(
          {
            date: "2026-11-09",
            domain: "example.com",
            items: [
              { file: "robots.txt", found: robots !== null, body: robots ?? "" },
              { file: "llms.txt", found: llms !== null, body: llms ?? "" },
            ],
          },
          null,
        ).map((m) => [m.key.replace("allowed:", ""), m.value]),
      )
    expect(allowed(null)).toMatchObject({ GPTBot: 1, ClaudeBot: 1, PerplexityBot: 1, llms_txt: 0 })
    expect(allowed("User-agent: *\nDisallow: /")).toMatchObject({ GPTBot: 0, "Google-Extended": 0 })
    expect(allowed("User-agent: *\nDisallow: /\n\nUser-agent: PerplexityBot\nAllow: /")).toMatchObject({ PerplexityBot: 1, GPTBot: 0 })
    expect(allowed("# bots\nuser-agent: gptbot # case-insensitive\nUser-Agent: ClaudeBot\nDisallow: /\nAllow: /$")).toMatchObject({ GPTBot: 1, ClaudeBot: 1 })
    expect(allowed("User-agent: OAI-SearchBot\nDisallow: /*\n\nUser-agent: *\nDisallow:")).toMatchObject({ "OAI-SearchBot": 0, GPTBot: 1 })
    expect(allowed("User-agent: *\nDisallow: /private")).toMatchObject({ GPTBot: 1 })
    expect(allowed(null, "# Example\n> A CRM")).toMatchObject({ llms_txt: 1 })
    expect(allowed(null, "<!doctype html><title>Not found</title>")).toMatchObject({ llms_txt: 0 }) // a soft 404
    // Lines end in \r\n, \r or \n. A user-agent matches by its leading product token.
    expect(allowed("User-agent: *\rAllow: /\r\rUser-agent: GPTBot\rDisallow: /\r")).toMatchObject({ GPTBot: 0, ClaudeBot: 1 })
    expect(allowed("User-agent: *\r\nAllow: /\r\n\r\nUser-agent: ClaudeBot\r\nDisallow: /")).toMatchObject({ ClaudeBot: 0, GPTBot: 1 })
    expect(allowed("User-agent: GPTBot/1.1\nDisallow: /\n\nUser-agent: *\nAllow: /")).toMatchObject({ GPTBot: 0, PerplexityBot: 1 })
  })

  test("ai_access status rules: robots.txt 401 or 403 allows every bot, 429 or 5xx fails; llms.txt 429 or 5xx is unknown, robots.txt kept", async () => {
    const answer = (robots: number | string, llms: number | string) => (url: string) =>
      Effect.suspend(() => {
        const r = url.endsWith("/robots.txt") ? robots : llms
        return typeof r === "number"
          ? Effect.fail(new ProviderError({ message: `page ${url}: HTTP ${r}`, status: r, retryable: r >= 500 }))
          : Effect.succeed({ url, status: 200, truncated: false, body: r })
      })
    const run = async (robots: number | string, llms: number | string) => {
      const db = openDb(":memory:")
      const signals = createSignals(db, { dataforseo: null, web: answer(robots, llms) })
      signals.setCap("global", 150)
      signals.setCap("default", 30)
      const project = upsertProject(db, profile)
      const r = await signals.collect(project.id, "ai_access", {}, false)
      return { r, metrics: Object.fromEntries(signals.metrics(project.id, "ai_access").map((m) => [m.key, m.value])) }
    }
    for (const status of [401, 403]) {
      const { r, metrics } = await run(status, 404)
      expect(r.status).toBe("collected")
      expect(metrics).toMatchObject({ "allowed:GPTBot": 1, "allowed:ClaudeBot": 1, llms_txt: 0 })
    }
    for (const status of [429, 500]) expect((await run(status, "# Example")).r.status).toBe("failed")
    for (const status of [429, 503]) {
      const { r, metrics } = await run("User-agent: GPTBot\nDisallow: /", status)
      expect(r.status).toBe("collected")
      expect(metrics["allowed:GPTBot"]).toBe(0)
      expect(metrics).not.toHaveProperty("llms_txt") // unknown, not 0
    }
  })

  test("ai_access: a 5xx fails the snapshot and is retryable; a huge robots.txt is cut so the payload stays under 200 KB", async () => {
    const fail = setup()
    const down = createSignals(fail.db, {
      dataforseo: null,
      web: (url) => Effect.fail(new ProviderError({ message: `page ${url}: HTTP 503`, status: 503, retryable: true })),
    })
    expect(await down.collect(fail.project.id, "ai_access", {}, false)).toMatchObject({ status: "failed", retryable: true })

    const big = setup()
    const huge = createSignals(big.db, {
      dataforseo: null,
      web: (url) => Effect.succeed({ url, status: 200, truncated: false, body: `User-agent: GPTBot\nDisallow: /\n${"# filler\n".repeat(100_000)}` }),
    })
    const r = await huge.collect(big.project.id, "ai_access", {}, false)
    if (r.status !== "collected") throw new Error(r.status)
    expect(JSON.stringify(r.snapshot.payload).length).toBeLessThan(200_000)
    expect(huge.metrics(big.project.id, "ai_access", { key: "allowed:GPTBot" }).map((m) => m.value)).toEqual([0])
  })
})

describe("cap check", () => {
  test("an engine name inherited from Object (constructor: x) is refused before any spend; dry_run returns no estimate", async () => {
    const s = setup()
    s.signals.setCap(s.project.id, 0.0001)
    for (const subject of ["constructor: x", "__proto__: x", "toString: x"]) {
      expect(await s.signals.collect(s.project.id, "ai_visibility", { subject }, false)).toMatchObject({ status: "refused" })
      expect(await s.signals.collect(s.project.id, "ai_visibility", { subject }, true)).toMatchObject({ status: "refused" })
    }
    expect(s.fake.calls).toEqual([])
    expect(s.spendRows()).toEqual([])
  })

  test("a collector whose estimate is not a finite number >= 0 is refused before any spend", async () => {
    const s = setup()
    const serp = collectors.get("serp_top30")!
    const estimate = serp.estimate
    try {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, "0.5" as unknown as number]) {
        serp.estimate = () => bad
        expect(await s.signals.collect(s.project.id, "serp_top30", { subject: "crm" }, false)).toMatchObject({ status: "refused" })
        expect(await s.signals.collect(s.project.id, "serp_top30", { subject: "crm" }, true)).toMatchObject({ status: "refused" })
      }
    } finally {
      serp.estimate = estimate
    }
    expect(s.fake.calls).toEqual([])
    expect(s.spendRows()).toEqual([])
  })
})
