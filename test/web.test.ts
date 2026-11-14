import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test"
import { createActions } from "../src/actions"
import { openDb } from "../src/db"
import { serveDashboard } from "../src/edge/web/server"
import { upsertProject } from "../src/projects"
import { createSignals } from "../src/signals"
import { fakeDataForSEO, fakeSearchConsole, fakeWeb } from "./fake-provider"

const W42 = "2026-10-12T08:00:00.000Z" // round 0
const W46 = "2026-11-09T08:00:00.000Z" // round 1, 4 weeks later

/** A two-week fixture with a script tag in a page diff, a keyword and the brief. Returns the database, then read only. */
const fixture = async () => {
  process.env.GTMKIT_NOW = W42
  const db = openDb(":memory:")
  const world = { round: 0 }
  const signals = createSignals(db, {
    dataforseo: fakeDataForSEO({ world }).dataforseo,
    gsc: fakeSearchConsole(world).gsc,
    // page_watch keeps text: an escaped tag in the page becomes a literal tag in the stored text and the diff.
    web: fakeWeb(world, "&lt;script&gt;alert('diff')&lt;/script&gt;").web,
  })
  signals.setCap("global", 150)
  signals.setCap("default", 30)
  const project = upsertProject(db, {
    id: "acme",
    domain: "example.com",
    brand_names: ["Example"],
    location: "United States",
    language: "English",
    competitors: ["rival-one.com"],
    keywords: ["crm for freelancers", "<script>alert('kw')</script>"].map((value) => ({ value })),
    prompts: ["What is the best CRM for freelancers?"],
    urls: ["https://rival-one.com/pricing"],
  })
  await signals.runDue()
  await signals.collect(project.id, "backlinks_summary", {}, false)
  const actions = createActions(db, signals)
  const evidence = [signals.query(project.id, "serp_top30", "crm for freelancers")[0]!.id]
  const target = { kind: "serp_top30", subject: "crm for freelancers", key: "position:example.com" }
  const done = actions.propose(project.id, { title: "Rewrite the <b>landing</b> page", rationale: "r", evidence, target })
  actions.update(project.id, done.id, "accepted")
  actions.update(project.id, done.id, "done")
  actions.propose(project.id, { title: "Open action", rationale: "r", evidence, target: { ...target, subject: "simple crm" } })

  world.round = 1
  process.env.GTMKIT_NOW = W46
  await signals.runDue()
  actions.saveBrief(project.id, "2026-W46", "# Brief 2026-W46\n\n<script>alert('brief')</script>\n\n- **Done**: position 2 -> 3")
  return { db, project }
}

describe("dashboard", () => {
  let s: Awaited<ReturnType<typeof fixture>>
  let server: ReturnType<typeof serveDashboard>
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(new URL(path, server.url), { headers })
    return { status: res.status, headers: res.headers, html: await res.text() }
  }
  const changes = () => (s.db.query("SELECT total_changes() AS n").get() as { n: number }).n

  beforeAll(async () => {
    s = await fixture()
    server = serveDashboard(s.db, { port: 0 })
  })
  afterAll(() => {
    server.stop(true)
  })

  test("AC13: the project page shows a position trend, the latest brief and the action list", async () => {
    const { status, html } = await get("/p/acme")
    expect(status).toBe(200)
    // example.com went from 2 to 3 for "crm for freelancers": the latest value, the change and a sparkline.
    expect(html).toMatch(/<td class="text">crm for freelancers<\/td><td>position:example\.com<\/td><td class="n">3<\/td><td class="n">\+1<\/td><td><svg class="spark"/)
    expect(html).toContain("# Brief 2026-W46")
    expect(html).toContain("Rewrite the &lt;b&gt;landing&lt;/b&gt; page")
    expect(html).toMatch(/<td>done<\/td>[\s\S]*?<td class="n">2<\/td><td class="n">3<\/td><td class="n">\+1<\/td>/)
    expect(html).toContain("Open action")
    expect(html).toContain("Team plan $30") // a recent page diff
    expect(html).toContain("referring_domains") // backlinks
  })

  test("a script tag in a page diff, the brief and a keyword is rendered as text", async () => {
    const { html, headers } = await get("/p/acme")
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain("&lt;script&gt;alert(&#39;diff&#39;)&lt;/script&gt;")
    expect(html).toContain("&lt;script&gt;alert(&#39;brief&#39;)&lt;/script&gt;")
    expect(html).toContain("&lt;script&gt;alert(&#39;kw&#39;)&lt;/script&gt;")
    expect(headers.get("content-security-policy")).toContain("default-src 'none'")
  })

  test("the project list shows month spend against the caps, halts and coverage", async () => {
    const { status, html } = await get("/")
    expect(status).toBe(200)
    expect(html).toContain('<a href="/p/acme">acme</a>')
    expect(html).toMatch(/\$0\.\d\d of \$30\.00/)
    expect(html).toContain("serp_top30 2/2")
    expect(html).toContain("Halts: none")
  })

  test("read pages respond without writing to the database", async () => {
    const before = changes()
    for (const path of ["/", "/p/acme", "/p/nope", "/nope"]) await get(path)
    expect((await get("/p/nope")).status).toBe(404)
    expect(changes()).toBe(before)
    expect(() => s.db.run("DELETE FROM briefs")).toThrow() // the served connection is query-only
  })

  test("only GET, and only for a loopback Host header", async () => {
    expect((await fetch(new URL("/", server.url), { method: "POST" })).status).toBe(405)
    expect((await get("/", { host: "attacker.example" })).status).toBe(403)
  })

  test("refuses to bind a non-loopback address", () => {
    for (const hostname of ["0.0.0.0", "::", "192.168.1.5", "example.com"]) {
      expect(() => serveDashboard(openDb(":memory:"), { hostname, port: 0 })).toThrow("refused")
    }
  })
})
