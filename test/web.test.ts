import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test"
import { createActions } from "../src/actions"
import { openDb } from "../src/db"
import { count, deltaChip, direction, num, SCRIPT, usd } from "../src/edge/web/html"
import { dashboard, serveDashboard } from "../src/edge/web/server"
import { upsertProject } from "../src/projects"
import { createSignals, GSC_TOTAL } from "../src/signals"
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
    // example.com went from 2 to 3 for "crm for freelancers": the best, the latest value and the change (worse).
    expect(html).toMatch(
      /<span class="l">crm for freelancers<\/span><span class="r"><span class="muted">best 2<\/span><b>3<\/b><span class="chip down" title="worse 1">\u2193 1<span class="sr"> worse<\/span><\/span><\/span><\/li>/,
    )
    // Six stats switch the main chart without script: radio inputs, the first (page one, the ladder) checked.
    expect(html.match(/<input class="pick" type="radio" name="m" id="m-\d"/g)).toHaveLength(6)
    expect(html).toContain('<input class="pick" type="radio" name="m" id="m-0" checked>')
    expect(html).toMatch(/<label class="cell" for="m-0"><span class="k">Page one keywords<\/span>/)
    // The rank ladder: a line and a direct label for the keyword.
    expect(html).toContain('<figure class="ladder"')
    expect(html).toMatch(/data-name="crm for freelancers" data-v="2\|3"/)
    expect(html).toContain('<b class="pill">3</b><span>crm for freelancers</span>')
    // The brief's markdown: headings, list items and bold only. Its first heading repeats the period, which the card
    // shows, so it is left out.
    expect(html).not.toContain("<h3>Brief 2026-W46</h3>")
    expect(html).toContain('<h2 class="title">Brief</h2></div><span class="aside">2026-W46</span>')
    expect(html).toContain("<li><strong>Done</strong>: position 2 -&gt; 3</li>")
    expect(html).toContain("Rewrite the &lt;b&gt;landing&lt;/b&gt; page")
    // A done action: the measured delta on its title line, before the status badge, and one meta line.
    expect(html).toMatch(/<span class="rt"><span class="d"><span>2 to 3<\/span><span class="chip down">\u2193 worse 1<\/span><\/span><span class="badge done">Done<\/span><\/span>/)
    expect(html).toMatch(/<span class="meta"><span title="serp_top30 \/ crm for freelancers \/ position:example\.com">Target: Google position of &#39;crm for freelancers&#39;<\/span>, based on snapshot \d+<\/span>/)
    expect(html).toContain("Target: Google position of &#39;crm for freelancers&#39;")
    expect(html).toContain("Open action")
    expect(html).toContain("Team plan $30") // a recent page diff
    expect(html).toMatch(/<span class="cnt">\+\d+ \/ \u2212\d+ lines<\/span><\/div><ul class="lines">/)
    expect(html).toMatch(/<li class="own"><span class="bar" style="--w:[\d.]+"><\/span><span class="l"><span>example\.com<span class="sub">your site<\/span><\/span><\/span><span class="r">[\d,]+/) // backlinks
  })

  test("a script tag in a page diff, the brief and a keyword is rendered as text", async () => {
    const { html, headers } = await get("/p/acme")
    // The only script is the static one, allowed by its hash. Stored text never becomes a tag or an attribute.
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    expect(scripts).toHaveLength(1)
    expect(scripts[0]![1]).toBe(SCRIPT)
    expect(html).not.toContain("<script>alert")
    expect(html).toContain("&lt;script&gt;alert(&#39;diff&#39;)&lt;/script&gt;")
    expect(html).toContain("&lt;script&gt;alert(&#39;brief&#39;)&lt;/script&gt;")
    expect(html).toContain("&lt;script&gt;alert(&#39;kw&#39;)&lt;/script&gt;")
    expect(html).toContain('data-name="&lt;script&gt;alert(&#39;kw&#39;)&lt;/script&gt;"')
    const csp = headers.get("content-security-policy")!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain(`script-src 'sha256-${createHash("sha256").update(SCRIPT).digest("base64")}'`)
    expect(csp).not.toMatch(/script-src[^;]*unsafe/)
    expect(csp).toContain("font-src 'self'")
  })

  test("serves the self-hosted fonts with a long cache, and nothing else under /fonts", async () => {
    for (const name of ["geist"]) {
      const res = await fetch(new URL(`/fonts/${name}.woff2`, server.url))
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("font/woff2")
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4))).toBe("wOF2")
    }
    expect((await get("/fonts/nope.woff2")).status).toBe(404)
    expect((await get("/fonts/bricolage-grotesque.woff2")).status).toBe(404) // removed: one family
    expect((await get("/fonts/geist.woff2", { host: "attacker.example" })).status).toBe(403)
    expect((await get("/")).html).toContain("url(/fonts/geist.woff2)")
  })

  test("the project list shows month spend against the caps, halts and coverage", async () => {
    const { status, html } = await get("/")
    expect(status).toBe(200)
    expect(html).toContain('<a class="id" href="/p/acme">acme</a>')
    expect(html).toMatch(/\$0\.\d\d <span class="muted">of \$30\.00<\/span>/)
    expect(html).toMatch(/<span>Rankings<\/span><span class="seg"><i class="f"><\/i><i class="f"><\/i><\/span><span class="muted">2 of 2<\/span>/)
    expect(html).toContain('<span class="status"><i class="dot ok"></i>Collection is running</span>')
    expect(html).not.toContain('class="halt"')
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

/** A project with metrics written straight into the table, rendered without a server. */
const stored = (keywords: string[], prompts: string[] = []) => {
  process.env.GTMKIT_NOW = "2026-11-16T09:00:00.000Z"
  const db = openDb(":memory:")
  upsertProject(db, {
    id: "site",
    domain: "example.com",
    brand_names: ["Example"],
    location: "United States",
    language: "English",
    competitors: ["rival-one.com"],
    keywords: keywords.map((value) => ({ value })),
    prompts,
    urls: [],
  })
  const insert = db.query("INSERT INTO metrics (project_id, kind, subject, key, date, value) VALUES ('site', ?, ?, ?, ?, ?)")
  const respond = (path: string) => dashboard(db)(new Request(`http://127.0.0.1${path}`))
  return {
    db,
    put: (kind: string, subject: string, key: string, date: string, value: number) => insert.run(kind, subject, key, date, value),
    html: async (path = "/p/site") => (await respond(path)).text(),
    status: (path: string) => respond(path).status,
  }
}

describe("dashboard pages from stored metrics", () => {
  test("AI crawlers show the project's own domain, not a newer check of another domain", async () => {
    const s = stored([])
    s.put("ai_access", "example.com", "allowed:GPTBot", "2026-11-01", 1)
    s.put("ai_access", "rival-one.com", "allowed:GPTBot", "2026-11-08", 0)
    const html = await s.html()
    expect(html).toContain('<span class="l">GPTBot</span><span class="r"><span class="chip up dot">Allowed</span></span>')
    expect(html).not.toContain("Blocked")
    expect(html).toContain("checked 1 Nov:")
  })

  test("the rank ladder charts at most 12 keywords inside the chart, and the Keywords card keeps all 40", async () => {
    const keywords = Array.from({ length: 40 }, (_, i) => `keyword ${String(i).padStart(2, "0")}`)
    const s = stored(keywords)
    keywords.forEach((k, i) => {
      for (const date of ["2026-11-02", "2026-11-09"]) s.put("serp_top30", k, "position:example.com", date, (i % 30) + 1)
    })
    const html = await s.html()
    expect(html).toContain("12 of 40 keywords charted, all in the Keywords card")
    expect(html.match(/<span class="l">keyword \d\d<\/span><span class="r"><b>/g)).toHaveLength(40)
    expect(html.match(/<li data-s=/g)).toHaveLength(12)
    expect(html).not.toMatch(/--y[dp]:-/)
    // The index counts all 40 in its page-one stat.
    expect(await s.html("/")).toMatch(/<span class="k">Page one keywords<\/span><span class="v">\d+<small> of 40<\/small>/)
  })

  test("the ladder caption counts every tracked keyword, also those never ranked", async () => {
    const s = stored(["one", "two", "never"])
    for (const k of ["one", "two"]) s.put("serp_top30", k, "position:example.com", "2026-11-09", 5)
    s.put("serp_top30", "never", "ai_overview", "2026-11-09", 0)
    expect(await s.html()).toContain("2 of 3 keywords charted, all in the Keywords card")
  })

  test("a keyword back in the top 30 after a week out gets a neutral chip, not a change", async () => {
    const s = stored(["comeback", "steady"])
    s.put("serp_top30", "comeback", "position:example.com", "2026-10-26", 5)
    s.put("serp_top30", "comeback", "ai_overview", "2026-11-02", 0) // checked, not in the top 30
    s.put("serp_top30", "comeback", "position:example.com", "2026-11-09", 7)
    s.put("serp_top30", "steady", "position:example.com", "2026-11-02", 9)
    s.put("serp_top30", "steady", "position:example.com", "2026-11-09", 4)
    const html = await s.html()
    // The best position is shown only when it is not the current one.
    expect(html).toContain('<span class="l">comeback</span><span class="r"><span class="muted">best 5</span><b>7</b><span class="chip">Back in top 30</span>')
    expect(html).toMatch(/<span class="l">steady<\/span><span class="r"><b>4<\/b><span class="chip up" title="improved 5">\u2191 5<span class="sr"> improved<\/span><\/span>/)
  })

  test("page one counts each keyword on its own latest check, and a day only some keywords have does not break a line", async () => {
    const s = stored(["alpha", "delta"])
    for (const date of ["2026-11-02", "2026-11-09", "2026-11-16"]) s.put("serp_top30", "alpha", "position:example.com", date, 3)
    s.put("serp_top30", "delta", "position:example.com", "2026-11-03", 12)
    s.put("serp_top30", "delta", "position:example.com", "2026-11-10", 9)
    const html = await s.html()
    expect(html).toContain('<span class="aside">Checked 10 Nov to 16 Nov</span>')
    // Before: alpha on page one on its 9 Nov check, delta not on its 3 Nov check.
    expect(html).toMatch(/Page one keywords<\/span><span class="v">2<small> of 2<\/small><span class="chip up">↑ 1/)
    expect(html).toMatch(/Top 3 keywords<\/span><span class="v">1<small> of 2<\/small><span class="muted nc">no change<\/span>/)
    const line = /data-name="alpha"[^>]*>(?:<path class="lead"[^>]*\/>)?<path class="ln draw" style="--i:\d+" d="([^"]+)"/.exec(html)![1]!
    expect(line.match(/M/g)).toHaveLength(1)
    expect(line.match(/L/g)).toHaveLength(2)
  })

  test("AI mention share counts answers to the tracked prompts only, on both pages", async () => {
    const s = stored([], ["q1"])
    for (const engine of ["chatgpt", "perplexity"]) {
      s.put("ai_visibility", `${engine}: q1`, "mentioned", "2026-11-09", 1)
      s.put("ai_visibility", `${engine}: an old prompt`, "mentioned", "2026-11-09", 0)
    }
    const html = await s.html()
    expect(html).toContain('<span class="k">AI mentions</span><span class="v">100%</span>')
    expect(html).toContain('<span>100% <span class="muted">2 of 2</span></span>')
    expect(html).toContain('data-name="Answers that mention the brand" data-v="100%"') // the chart too
    expect(html).toContain("an old prompt") // still in the matrix
    const index = await s.html("/")
    expect(index).toContain('<span class="k">AI mentions</span><span class="v">100%</span>')
    expect(index).toContain('<span><span class="sr">AI mentions </span><span class="fv">100%</span><span class="fd"></span></span>')
  })

  test("a stored non-finite value never reaches the text", async () => {
    const s = stored(["kw"])
    s.put("serp_top30", "kw", "position:example.com", "2026-11-02", 4)
    s.put("serp_top30", "kw", "position:example.com", "2026-11-09", Number("9e999"))
    s.put("gsc_performance", GSC_TOTAL, "clicks", "2026-11-02", 10)
    s.put("gsc_performance", GSC_TOTAL, "clicks", "2026-11-09", Number("9e999"))
    for (const html of [await s.html(), await s.html("/")]) {
      expect(html).not.toMatch(/Infinity|NaN|\u221e/)
    }
    expect(await s.html()).toContain('<span class="l">kw</span><span class="r"><b>4</b>')
    expect([num(Infinity), num(Number.NaN), count(-Infinity), usd(Infinity)]).toEqual(["", "", "", ""])
  })

  test("a malformed escape in a project path answers 404", () => {
    expect(stored([]).status("/p/%E0%A4%A")).toBe(404)
  })

  test("share of voice counts the latest answers that mention each name", async () => {
    const s = stored([], ["q1", "q2"])
    const answers = [
      ["chatgpt: q1", 1, 1],
      ["perplexity: q1", 1, 0],
      ["chatgpt: q2", 1, 0],
      ["perplexity: q2", 0, 0],
    ] as const
    for (const [subject, brand, rival] of answers) {
      s.put("ai_visibility", subject, "mentioned", "2026-11-09", brand)
      s.put("ai_visibility", subject, "mentioned:rival-one.com", "2026-11-09", rival)
    }
    const html = await s.html()
    expect(html).toContain('<span class="l"><span>example.com<span class="sub">Example</span></span></span><span class="r"><span>75% <span class="muted">3 of 4</span></span></span>')
    expect(html).toContain('<span class="l"><span>rival-one.com</span></span><span class="r"><span>25% <span class="muted">1 of 4</span></span></span>')
  })

  test("the index clicks chart takes each project's latest clicks by date, so its last point equals the stat", async () => {
    const s = stored([])
    upsertProject(s.db, { id: "other", domain: "other.example", brand_names: [], location: "United States", language: "English", competitors: [], keywords: [], prompts: [], urls: [] })
    const other = s.db.query("INSERT INTO metrics (project_id, kind, subject, key, date, value) VALUES ('other', 'gsc_performance', ?, 'clicks', ?, ?)")
    s.put("gsc_performance", GSC_TOTAL, "clicks", "2026-11-02", 100)
    s.put("gsc_performance", GSC_TOTAL, "clicks", "2026-11-09", 200)
    other.run(GSC_TOTAL, "2026-11-03", 10) // collected a day later
    other.run(GSC_TOTAL, "2026-11-10", 20)
    const index = await s.html("/")
    expect(index).toContain('<span class="k">Clicks, 7 days</span><span class="v">220')
    expect(index).toContain('data-name="Clicks, all projects" data-v="100|110|210|220"')
    // The same values as a hidden table, in the markup without any script.
    expect(index).toContain('<tr><th scope="row">10 Nov</th><td>220</td></tr>')
    expect(index).toContain("<span>Since 2 Nov</span>")
  })

  test("the AI share chart takes each tracked answer's latest mention by date, so its last point equals the stat", async () => {
    const s = stored([], ["q1"])
    s.put("ai_visibility", "chatgpt: q1", "mentioned", "2026-11-02", 1)
    s.put("ai_visibility", "chatgpt: q1", "mentioned", "2026-11-09", 1)
    s.put("ai_visibility", "perplexity: q1", "mentioned", "2026-11-03", 0) // one engine a day later
    s.put("ai_visibility", "perplexity: q1", "mentioned", "2026-11-10", 1)
    const html = await s.html()
    expect(html).toContain('<span class="k">AI mentions</span><span class="v">100%')
    expect(html).toContain('data-name="Answers that mention the brand" data-v="100%|50%|50%|100%"')
    expect(html).toContain("<span>Since 2 Nov</span>")
  })

  test("the top-3 chart counts keywords in the top 3 on their own latest check by each date, with a hidden table", async () => {
    const s = stored(["a", "b", "c"])
    s.put("serp_top30", "a", "position:example.com", "2026-11-02", 2)
    s.put("serp_top30", "a", "position:example.com", "2026-11-09", 5)
    s.put("serp_top30", "b", "position:example.com", "2026-11-02", 4)
    s.put("serp_top30", "b", "position:example.com", "2026-11-09", 3)
    s.put("serp_top30", "c", "position:example.com", "2026-11-03", 1)
    const html = await s.html()
    expect(html).toMatch(/Top 3 keywords<\/span><span class="v">2<small> of 3<\/small>/)
    expect(html).toContain('data-name="Keywords in the top 3" data-v="1|2|2"')
    // The ladder's text equivalent: one column per charted keyword, best position first.
    expect(html).toContain('<caption>Google position of each charted keyword by date</caption><thead><tr><th scope="col">Date</th><th scope="col">c</th><th scope="col">b</th><th scope="col">a</th></tr>')
    expect(html).toContain('<tr><th scope="row">9 Nov</th><td></td><td>3</td><td>5</td></tr>')
  })

  test("page changes show the 5 newest and fold the rest, with line counts in words and URLs without the scheme", async () => {
    const s = stored([])
    const url = "https://rival-one.com/pricing"
    const texts = ["A", "A\nB", "A", "A\nC", "D\nC", "D\nE", "F\nE"]
    const insert = s.db.query(
      "INSERT INTO snapshots (project_id, kind, subject, bucket, params_hash, status, captured_at, payload) VALUES ('site', 'page_watch', ?, ?, 'h', 'ok', ?, ?)",
    )
    texts.forEach((text, i) => {
      const at = `2026-11-${String(8 + i).padStart(2, "0")}T08:00:00.000Z`
      insert.run(url, `b${i}`, at, JSON.stringify({ date: at.slice(0, 10), url, final_url: url, truncated: false, items: [{ text }] }))
    })
    const html = await s.html()
    const [shown, folded] = html.split('<details class="more"><summary>Show all 6</summary>')
    expect(folded).toBeDefined()
    expect(shown!.match(/<li><div class="ch">/g)).toHaveLength(5)
    expect(folded!.match(/<li><div class="ch">/g)).toHaveLength(1)
    expect(html).toContain(`<span class="u" title="${url}">rival-one.com/pricing</span>`)
    expect(shown).toContain('<span class="cnt">+1 / −1 lines</span>')
    expect(shown).toContain('<span class="cnt">−1 line</span>')
    expect(folded).toContain('<span class="cnt">+1 line</span>')
  })

  test("bold in a brief wraps escaped text only", async () => {
    const s = stored([])
    createActions(s.db, createSignals(s.db, { dataforseo: null })).saveBrief("site", "2026-W47", "**<img onerror=x>**")
    const html = await s.html()
    expect(html).toContain("<strong>&lt;img onerror=x&gt;</strong>")
    expect(html).not.toContain("<img")
  })

  test("a long brief shows its start and folds the rest into a details, without a heading that repeats the period", async () => {
    const s = stored([])
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} ${"of the weekly brief ".repeat(6)}`)
    const markdown = `# Weekly brief, 2026-W47\n\n${paragraphs.join("\n\n")}\n\nWhat to do:\n\n- One\n- Two`
    createActions(s.db, createSignals(s.db, { dataforseo: null })).saveBrief("site", "2026-W47", markdown)
    const html = await s.html()
    expect(html).not.toContain("Weekly brief, 2026-W47</h")
    expect(html).toContain('<h2 class="title">Brief</h2></div><span class="aside">2026-W47</span>')
    const [shown, folded] = html.split('<details class="more"><summary>Read full brief</summary>')
    expect(folded).toBeDefined()
    expect(shown).toContain("<p>Paragraph 1 ")
    expect(folded).toContain("<p>Paragraph 12 ")
    // The lead-in that ends with a colon stays with its list.
    expect(folded).toContain("<p>What to do:</p><ul><li>One</li><li>Two</li></ul>")
  })

  test("delta chips colour by meaning: better green, worse red, other domains and unclear keys neutral", () => {
    expect(deltaChip(2 - 10, direction("issues", "example.com"))).toContain('class="chip up"')
    expect(deltaChip(5, direction("clicks", "example.com"))).toContain('class="chip up">\u2191 5')
    expect(deltaChip(3, direction("position:example.com", "example.com"))).toContain('class="chip down">\u2193 worse 3')
    expect(deltaChip(3, direction("mentioned:rival-one.com", "example.com"))).toBe('<span class="chip">+3</span>')
    expect(deltaChip(-4, direction("position:rival-one.com", "example.com"))).toBe('<span class="chip">\u22124</span>')
    expect(deltaChip(2, direction("difficulty", "example.com"))).toBe('<span class="chip">+2</span>')
    // The hidden word is there only where the visible text does not say better or worse.
    expect(deltaChip(5, "higher")).toContain('<span class="sr"> better</span>')
    expect(deltaChip(-1, "lower")).toBe('<span class="chip up">↑ improved 1</span>')
    // The short form for dense rows: arrow and number, the word hidden and in the title.
    expect(deltaChip(-2, "lower", "", true)).toBe('<span class="chip up" title="improved 2">↑ 2<span class="sr"> improved</span></span>')
    expect(deltaChip(3, "lower", "", true)).toBe('<span class="chip down" title="worse 3">↓ 3<span class="sr"> worse</span></span>')
    expect(deltaChip(0, "lower", "", true)).toBe('<span class="muted nc" title="no change">–<span class="sr"> no change</span></span>')
  })
})
