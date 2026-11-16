import type { Database } from "bun:sqlite"
import { createActions, type ListedAction, type Target } from "../../actions"
import { now } from "../../env"
import { getProject, type Project } from "../../projects"
import { bareDomain, collectors, createSignals, GSC_TOTAL, type Metric } from "../../signals"
import { ladder, trend } from "./charts"
import { count, day, deltaChip, direction, esc, moment, monthName, num, page, usd } from "./html"

const PAGE_DIFF_DAYS = 35
const PAGE_DIFFS = 20
/** Lines shown per side of a page change. */
const PAGE_LINES = 10
const SEGMENTS = 10
/** Brief lines shown before "Read full brief", and characters per line in a half-width card. */
const BRIEF_LINES = 14
const BRIEF_CHARS = 84
/** Page changes shown before "Show all". */
const PAGE_CHANGES_SHOWN = 5
const KIND_LABEL: Record<string, string> = {
  serp_top30: "Rankings",
  gsc_performance: "Search Console",
  ai_visibility: "AI answers",
  ai_access: "AI crawlers",
  page_watch: "Page changes",
  backlinks_summary: "Backlinks",
  keyword_volume: "Keyword volume",
  keyword_ideas: "Keyword ideas",
  competitor_keywords: "Competitor keywords",
  keyword_gap: "Keyword gap",
  site_audit: "Site audit",
}
const ENGINES = ["chatgpt", "perplexity", "gemini", "claude"]
const ENGINE_LABEL: Record<string, string> = { chatgpt: "ChatGPT", perplexity: "Perplexity", gemini: "Gemini", claude: "Claude" }
const GSC_LABEL: Record<string, string> = { clicks: "clicks", impressions: "impressions", position: "average position" }
const STATUS_ORDER = ["proposed", "accepted", "done", "dropped"]

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const maxDate = (ms: { date: string }[]) => ms.reduce((a, m) => (m.date > a ? m.date : a), "")
/** The values of one subject's metrics on its latest date, and on the date before, by key. */
const lastTwo = (ms: Metric[]) => {
  const dates = [...new Set(ms.map((m) => m.date))].sort()
  const on = (d: string | undefined) => new Map(ms.filter((m) => m.date === d).map((m) => [m.key, m.value]))
  return { date: dates.at(-1) ?? "", now: on(dates.at(-1)), prev: dates.length > 1 ? on(dates.at(-2)) : null }
}
const empty = (html: string) => `<p class="empty">${html}</p>`
const share = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "")
const series = (points: { date: string; value: number }[]): Metric[] => points.map((p) => ({ subject: "", key: "", ...p }))
/** "Since 31 Aug": the first of the dates a page charts. */
const period = (dates: string[]) => {
  const first = dates.filter(Boolean).sort()[0]
  return first ? `Since ${day(first)}` : "No data yet"
}

/**
 * For each date in any group: the latest metric of each group at or before that date, for the groups that have one.
 * Groups collected on different days (a project a day later, one engine on its own date) then line up.
 */
const carry = (groups: Metric[][]) => {
  const sorted = groups.map((g) => [...g].sort((a, b) => a.date.localeCompare(b.date)))
  return [...new Set(sorted.flat().map((m) => m.date))].sort().map((date) => ({
    date,
    values: sorted.flatMap((g) => {
      const m = g.findLast((x) => x.date <= date)
      return m ? [m.value] : []
    }),
  }))
}

/** The top bar. The month spend shows on a project page; the index has it in its stat strip. */
const topBar = (lastTick: string | null, spend?: { month: string; spent: number; cap: number | null }) =>
  `<header class="top"><a class="wordmark" href="/">gtmkit</a><div class="acts"><span>${lastTick ? `Last collection ${esc(moment(lastTick))}` : "No collection has run yet"}</span>${spend ? `<span>${esc(monthName(spend.month))} spend <b>${esc(usd(spend.spent))} of ${esc(usd(spend.cap))}</b></span>` : ""}</div></header>`

/** The site row: a name, a status dot with its words, and what the page covers on the right. Two rows on a phone. */
const siteRow = (name: string, sub: string, status: { ok: boolean; text: string }, right: string[]) =>
  `<div class="site"><div class="who"><h1>${name}</h1>${sub ? `<span class="dom">${sub}</span>` : ""}</div><div class="meta"><span class="status"><i class="dot ${status.ok ? "ok" : "bad"}"></i>${status.text}</span><span class="aside">${right.map((r) => `<span>${r}</span>`).join("")}</span></div></div>`

interface Stat {
  label: string
  value: string
  delta?: string
  /** The chart shown when the stat is selected, or undefined for a stat that only shows its figure. */
  view?: string
}

/**
 * The main card: a strip of stats over one large chart. Each stat with a view is a radio input and its label, and CSS
 * shows the view of the checked one, so it switches without script. The first is checked.
 */
const mainCard = (group: string, title: string, stats: Stat[]) => {
  const views = stats.filter((s) => s.view !== undefined)
  const cell = (s: Stat) => `<span class="k">${s.label}</span><span class="v">${s.value}${s.delta ?? ""}</span>`
  // A fieldset names the radio group for screen readers; its legend is visually hidden.
  return `<section class="card main" aria-label="${esc(title)}"><fieldset class="grp"><legend class="sr">${esc(title)}: chart to show</legend>${views.map((_, i) => `<input class="pick" type="radio" name="${group}" id="${group}-${i}"${i === 0 ? " checked" : ""}>`).join("")}
<div class="cells">${views.map((s, i) => `<label class="cell" for="${group}-${i}">${cell(s)}</label>`).join("")}${stats
    .filter((s) => s.view === undefined)
    .map((s) => `<div class="cell">${cell(s)}</div>`)
    .join("")}</div>
<div class="views">${views.map((s) => `<div class="view">${s.view}</div>`).join("")}</div></fieldset></section>`
}

/**
 * A card with a row of small tabs over its panes. Several tabs are radio inputs and labels, switched by CSS like the
 * main card. A card with one pane shows a plain title instead. `aside` sits at the right of the tab row.
 */
const card = (title: string, group: string, tabs: [string, string][], aside = "") => {
  const many = tabs.length > 1
  const heads = many ? tabs.map(([t], i) => `<label for="${group}-${i}">${t}</label>`).join("") : `<h2 class="title">${tabs[0]![0]}</h2>`
  const inner = `<div class="tabrow"><div class="tabs">${heads}</div>${aside ? `<span class="aside">${aside}</span>` : ""}</div>
<div class="panes">${tabs.map(([, body]) => `<div class="pane">${body}</div>`).join("")}</div>`
  return `<section class="card tabbed c-${group}" aria-label="${esc(title)}">${
    many
      ? `<fieldset class="grp"><legend class="sr">${esc(title)}: view</legend>${tabs.map((_, i) => `<input class="pick" type="radio" name="${group}" id="${group}-${i}"${i === 0 ? " checked" : ""}>`).join("")}${inner}</fieldset>`
      : inner
  }</section>`
}

interface Row {
  label: string
  value: string
  /** The bar behind the row, as a share of the longest, 0 for none. */
  w?: number
  cls?: string
}
/** A column header and rows, each with a filled bar behind its text and its value right-aligned. */
const rows = (left: string, right: string, items: Row[]) =>
  `<div class="th"><span>${left}</span><span>${right}</span></div><ul class="rows">${items
    .map(
      (r) =>
        `<li${r.cls ? ` class="${r.cls}"` : ""}>${r.w ? `<span class="bar" style="--w:${Math.min(r.w, 1).toFixed(3)}"></span>` : ""}<span class="l">${r.label}</span><span class="r">${r.value}</span></li>`,
    )
    .join("")}</ul>`

/** Collected of expected, as segments, or as a bar past 10 subjects. */
const coverage = (kind: string, c: { collected: number; expected: number }) => {
  const shape =
    c.expected <= SEGMENTS
      ? `<span class="seg">${Array.from({ length: c.expected }, (_, i) => `<i${i < c.collected ? ' class="f"' : ""}></i>`).join("")}</span>`
      : `<span class="segbar"><span style="width:${((c.collected / c.expected) * 100).toFixed(0)}%"></span></span>`
  return `<li title="${esc(kind)}"><span>${esc(KIND_LABEL[kind] ?? kind)}</span>${shape}<span class="muted">${c.collected} of ${c.expected}</span></li>`
}

/**
 * Stored markdown, escaped first, then only headings, "- " lists, paragraphs and **bold** on the escaped text. Returns
 * its blocks with an estimate of the lines each takes in a card, for showing the start in full.
 */
const briefBlocks = (markdown: string) => {
  const bold = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  const lines = (text: string) => Math.max(1, Math.ceil(text.length / BRIEF_CHARS))
  const out: { html: string; text: string; lines: number }[] = []
  let para: string[] = []
  let list: string[] = []
  const endPara = () => {
    if (para.length) out.push({ html: `<p>${bold(para.join(" "))}</p>`, text: para.join(" "), lines: lines(para.join(" ")) })
    para = []
  }
  const endList = () => {
    if (list.length) out.push({ html: `<ul>${list.map((li) => `<li>${bold(li)}</li>`).join("")}</ul>`, text: list.join(" "), lines: list.reduce((n, li) => n + lines(li), 0) })
    list = []
  }
  for (const line of esc(markdown).split(/\r?\n/)) {
    const t = line.trim()
    const h = /^(#{1,3}) (.+)$/.exec(t)
    if (!t) {
      endPara()
      endList()
    } else if (h) {
      endPara()
      endList()
      const level = h[1]!.length + 2
      out.push({ html: `<h${level}>${bold(h[2]!)}</h${level}>`, text: h[2]!, lines: 2 })
    } else if (t.startsWith("- ")) {
      endPara()
      list.push(t.slice(2))
    } else {
      endList()
      para.push(t)
    }
  }
  endPara()
  endList()
  return out
}

/**
 * The brief for its card: a first heading that repeats the period is left out, as the card shows it. About the first
 * 14 lines show in full, the rest opens in a native details.
 */
const briefHtml = (markdown: string, period: string) => {
  const blocks = briefBlocks(markdown)
  if (blocks[0]?.html.startsWith("<h") && blocks[0].text.includes(esc(period))) blocks.shift()
  let used = 0
  const cut = blocks.findIndex((b, i) => (used += b.lines) > BRIEF_LINES && i > 0)
  // A lead-in that ends with a colon stays with the list after it.
  const at = cut > 1 && blocks[cut - 1]!.text.endsWith(":") ? cut - 1 : cut
  const shown = at === -1 ? blocks : blocks.slice(0, at)
  const rest = at === -1 ? [] : blocks.slice(at)
  return `${shown.map((b) => b.html).join("")}${rest.length ? `<details class="more"><summary>Read full brief</summary>${rest.map((b) => b.html).join("")}</details>` : ""}`
}

/** An action's target metric in plain words. The kind, subject and key stay in its title attribute. */
const targetText = ({ kind, subject, key }: Target, domain: string) => {
  const q = `'${subject}'`
  const [base, other] = key.split(/:(.*)/s) as [string, string | undefined]
  if (kind === "serp_top30") {
    if (base === "position") return other === domain ? `Google position of ${q}` : `Google position of ${other} for ${q}`
    if (base === "ai_overview") return `AI Overview shown for ${q}`
    if (base === "ai_overview_cited") return `${other ?? "Site"} cited in the AI Overview for ${q}`
  }
  if (kind === "gsc_performance" && GSC_LABEL[key]) return `Search Console ${GSC_LABEL[key]}, ${subject === GSC_TOTAL ? "whole site" : `query ${q}`}`
  if (kind === "ai_visibility") {
    const m = /^(\w+): ([\s\S]+)$/.exec(subject)
    const who = other ?? (base === "mentioned" ? "the brand" : domain)
    if (m && (base === "mentioned" || base === "cited"))
      return `${ENGINE_LABEL[m[1]!] ?? m[1]} ${base === "mentioned" ? "mentions" : "cites"} ${who} for '${m[2]}'`
  }
  if (kind === "ai_access") return base === "allowed" ? `robots.txt allows ${other}` : base === "llms_txt" ? `llms.txt on ${subject}` : `${key} on ${subject}`
  if (kind === "backlinks_summary") return `${key === "referring_domains" ? "Referring domains" : cap1(key)} of ${subject}`
  return `${cap1(key)} of ${q}`
}

export const createPages = (db: Database) => {
  const signals = createSignals(db, { dataforseo: null })
  const actions = createActions(db, signals)
  /** Stored metrics with a finite value. Every page reads metrics through this. */
  const metrics = (...args: Parameters<typeof signals.metrics>) => signals.metrics(...args).filter((m) => Number.isFinite(m.value))

  /**
   * Each tracked keyword with its own-domain positions and its latest AI Overview state. Page one counts each keyword
   * on its own latest check, and the count before on its own check before that, as keywords can be checked on
   * different days.
   */
  const rankRows = (p: Project, domain: string) => {
    const keywords = collectors.get("serp_top30")?.subjects(p) ?? []
    const bySubject = Map.groupBy(metrics(p.id, "serp_top30"), (m) => m.subject)
    const own = `position:${domain}`
    const rows = keywords.map((name, i) => {
      const ms = bySubject.get(name) ?? []
      const points = ms.filter((m) => m.key === own)
      const latest = lastTwo(ms)
      const checks = [...new Set(ms.map((m) => m.date))].sort()
      return {
        key: `k${i}`,
        name,
        points,
        checks,
        checked: latest.date,
        prevCheck: checks.at(-2),
        ranking: latest.date !== "" && points.at(-1)?.date === latest.date,
        aio: latest.now.get("ai_overview"),
        cited: latest.now.get("ai_overview_cited"),
      }
    })
    const onPageOn = (r: (typeof rows)[number], d: string | undefined) => r.points.some((m) => m.date === d && m.value <= 10)
    const lasts = rows.map((r) => r.checked).filter(Boolean).sort()
    return {
      rows,
      /** The first and last of the keywords' latest checks, "" when none was checked. */
      checked: lasts.at(-1) ?? "",
      firstChecked: lasts[0] ?? "",
      onPage: rows.filter((r) => onPageOn(r, r.checked)).length,
      onPagePrev: rows.some((r) => r.prevCheck) ? rows.filter((r) => onPageOn(r, r.prevCheck)).length : null,
    }
  }

  /** The latest answer per engine and prompt, with the answer before it. */
  const answersOf = (p: Project) =>
    [...Map.groupBy(metrics(p.id, "ai_visibility"), (m) => m.subject)].flatMap(([subject, ms]) => {
      const m = /^(\w+): ([\s\S]+)$/.exec(subject)
      return m ? [{ engine: m[1]!, prompt: m[2]!, ...lastTwo(ms) }] : []
    })
  type Answer = ReturnType<typeof answersOf>[number]

  const gscOf = (p: Project) => Map.groupBy(metrics(p.id, "gsc_performance", { subject: GSC_TOTAL }), (m) => m.key)

  /**
   * The four outcomes of a project: page-one keywords, clicks, AI mention share and open actions. `answers` is every
   * stored answer, for the matrix. `tracked` keeps the current prompts only, for the share figures.
   */
  const outcomes = (p: Project) => {
    const domain = bareDomain(p.domain)
    const ranks = rankRows(p, domain)
    const answers = answersOf(p)
    const tracked = answers.filter((a) => p.prompts.includes(a.prompt))
    const withPrev = tracked.filter((a) => a.prev)
    const clicks = gscOf(p).get("clicks") ?? []
    return {
      domain,
      ranks,
      answers,
      tracked,
      clicks,
      mentioned: tracked.filter((a) => a.now.get("mentioned") === 1).length,
      prevMentioned: withPrev.filter((a) => a.prev!.get("mentioned") === 1).length,
      prevAnswers: withPrev.length,
      open: actions.list(p.id).filter((a) => a.status === "proposed" || a.status === "accepted").length,
    }
  }
  type Outcomes = ReturnType<typeof outcomes>


  /** For each date any keyword was checked: the keywords whose own latest check by then passes `ok`. */
  const countOver = (keywords: Outcomes["ranks"]["rows"], ok: (position: number) => boolean) =>
    series(
      [...new Set(keywords.flatMap((r) => r.checks))].sort().map((date) => ({
        date,
        value: keywords.filter((r) => {
          const check = r.checks.findLast((c) => c <= date)
          return check !== undefined && r.points.some((m) => m.date === check && ok(m.value))
        }).length,
      })),
    )

  /** Per date, the share in percent of answers to tracked prompts whose latest answer by then mentions the brand. */
  const shareOver = (ps: Project[]) => {
    // One group per answer: a project's engine and tracked prompt.
    const answers = ps.flatMap((p) => [
      ...Map.groupBy(
        metrics(p.id, "ai_visibility", { key: "mentioned" }).filter((m) => {
          const x = /^(\w+): ([\s\S]+)$/.exec(m.subject)
          return x !== null && p.prompts.includes(x[2]!)
        }),
        (m) => m.subject,
      ).values(),
    ])
    return series(
      carry(answers).map(({ date, values }) => ({ date, value: Math.round((values.filter((v) => v === 1).length / values.length) * 100) })),
    )
  }

  /** Collection is running, halted, or refused for want of a global cap. */
  const collecting = (s: ReturnType<typeof signals.status>) => {
    const halts = s.halts.map((h) => h.slice("halt:".length))
    if (s.global.cap_usd === null) return { ok: false, text: "No global cap, collection refused" }
    if (halts.length) return { ok: false, text: `Collection halted for ${halts.includes("all") ? "every kind" : esc(halts.join(", "))}` }
    return { ok: true, text: "Collection is running" }
  }

  const index = () => {
    const s = signals.status()
    const halts = s.halts.map((h) => h.slice("halt:".length))
    const banner = halts.length
      ? `<div class="halt" role="alert"><strong>Collection is halted for ${halts.includes("all") ? "every kind" : esc(halts.join(", "))}.</strong>
<p>${halts.includes("all") ? "The DataForSEO balance dropped more than the spend ledger recorded. " : ""}${halts.some((h) => h !== "all") ? "A reported cost was above its estimate: fix the price in <code>src/signals/prices.ts</code>. " : ""}Then run <code>gtmkit budget --clear-halt</code> in a terminal.</p></div>`
      : s.global.cap_usd === null
        ? '<div class="halt" role="alert"><strong>No global cap is set, so every collection is refused.</strong><p>Set one with <code>gtmkit budget</code>.</p></div>'
        : ""
    const order = Object.keys(KIND_LABEL)
    const all = s.projects.flatMap((st) => {
      const p = getProject(db, st.id)
      return p ? [{ st, p, o: outcomes(p) }] : []
    })
    const os = all.map((x) => x.o)
    const keywords = os.flatMap((o) => o.ranks.rows)
    const onPage = os.reduce((n, o) => n + o.ranks.onPage, 0)
    const ranked = os.filter((o) => o.ranks.checked)
    const onPagePrev = ranked.length && ranked.every((o) => o.ranks.onPagePrev !== null) ? ranked.reduce((n, o) => n + o.ranks.onPagePrev!, 0) : null
    const withClicks = os.filter((o) => o.clicks.length)
    const clicks = withClicks.reduce((n, o) => n + o.clicks.at(-1)!.value, 0)
    const clicksPrev = withClicks.length && withClicks.every((o) => o.clicks.length > 1) ? withClicks.reduce((n, o) => n + o.clicks.at(-2)!.value, 0) : null
    const clicksOver = series(carry(os.map((o) => o.clicks)).map(({ date, values }) => ({ date, value: values.reduce((n, v) => n + v, 0) })))
    const answers = os.reduce((n, o) => n + o.tracked.length, 0)
    const mentioned = os.reduce((n, o) => n + o.mentioned, 0)
    const prevAnswers = os.reduce((n, o) => n + o.prevAnswers, 0)
    const sharePts = answers && prevAnswers ? Math.round((mentioned / answers) * 100) - Math.round((os.reduce((n, o) => n + o.prevMentioned, 0) / prevAnswers) * 100) : null
    const mentionsOver = shareOver(all.map((x) => x.p))
    const pageOneOver = countOver(keywords, (v) => v <= 10)
    const main = mainCard("m", "All projects", [
      {
        label: "Clicks, 7 days",
        value: withClicks.length ? esc(count(clicks)) : '<small class="muted">no data</small>',
        delta: clicksPrev === null ? "" : deltaChip(clicks - clicksPrev, "higher"),
        view: trend("Clicks, all projects", clicksOver, count, { id: "t-clicks" }) || empty("No Search Console data yet."),
      },
      {
        label: "Page one keywords",
        value: keywords.length ? `${onPage}<small> of ${keywords.length}</small>` : '<small class="muted">none tracked</small>',
        delta: onPagePrev === null ? "" : deltaChip(onPage - onPagePrev, "higher"),
        view: trend("Keywords on page one, all projects", pageOneOver, count, { id: "t-page" }) || empty("No rankings yet."),
      },
      {
        label: "AI mentions",
        value: answers ? share(mentioned, answers) : '<small class="muted">no answers</small>',
        delta: sharePts === null ? "" : deltaChip(sharePts, "higher", " pts"),
        view: trend("Answers that mention the brand, all projects", mentionsOver, (n) => `${n}%`, { id: "t-ai" }) || empty("No answers to tracked prompts yet."),
      },
      { label: "Open actions", value: String(os.reduce((n, o) => n + o.open, 0)) },
      { label: "Spend this month", value: `${esc(usd(s.global.spent_usd))}<small> of ${esc(usd(s.global.cap_usd))}</small>` },
    ])
    const most = Math.max(1, ...os.map((o) => o.clicks.at(-1)?.value ?? 0))
    const projectRows = all.map(({ st, p, o }) => {
      const cov = Object.entries(st.coverage)
        .filter(([, c]) => c.expected > 0)
        .sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
      const [got, of] = cov.reduce(([g, e], [, c]) => [g + c.collected, e + c.expected], [0, 0])
      const last = o.clicks.at(-1)
      const prev = o.clicks.at(-2)
      const pts = o.prevAnswers ? Math.round((o.mentioned / o.tracked.length) * 100) - Math.round((o.prevMentioned / o.prevAnswers) * 100) : null
      // Each figure: its value right-aligned and a fixed slot for its delta, so values line up between rows.
      const fig = (label: string, value: string, delta = "") => `<span><span class="sr">${label} </span><span class="fv">${value}</span><span class="fd">${delta}</span></span>`
      const figures = [
        fig("Page one", o.ranks.rows.length ? `${o.ranks.onPage} <span class="muted">of ${o.ranks.rows.length}</span>` : '<span class="muted">none</span>'),
        fig("Clicks, 7 days", last ? esc(count(last.value)) : '<span class="muted">no data</span>', last && prev ? deltaChip(last.value - prev.value, "higher") : ""),
        fig("AI mentions", o.tracked.length ? share(o.mentioned, o.tracked.length) : '<span class="muted">none</span>', pts === null ? "" : deltaChip(pts, "higher", " pts")),
        fig("Spend this month", `${esc(usd(st.spent_usd))} <span class="muted">of ${esc(usd(st.cap_usd))}</span>`),
      ].join("")
      return `<li class="proj">${last ? `<span class="bar" style="--w:${(last.value / most).toFixed(3)}"></span>` : ""}<span class="l"><a class="id" href="/p/${esc(encodeURIComponent(p.id))}">${esc(p.id)}</a><span class="muted">${esc(o.domain)}</span></span><span class="r figs">${figures}</span></li>
<li class="cov">${cov.length ? `<details><summary>${got} of ${of} collected this week</summary><ul class="covgrid">${cov.map(([kind, c]) => coverage(kind, c)).join("")}</ul></details>` : '<span class="muted">Nothing tracked yet</span>'}</li>`
    })
    const head = `<div class="th"><span>Project <span class="sub">bar length by clicks, 7 days</span></span><span class="figs"><span>Page one</span><span>Clicks, 7 days</span><span>AI mentions</span><span>Spend</span></span></div>`
    const projects = all.length
      ? card("Projects", "pj", [["Projects", `${head}<ul class="rows">${projectRows.join("")}</ul>`]], `${all.length} ${all.length === 1 ? "project" : "projects"}`)
      : card("Projects", "pj", [["Projects", empty("No projects yet. In the repo of a site you own, run <code>/gtmkit:gtm-onboard</code> in Claude Code to create one.")]])
    return page(
      "gtmkit",
      `${topBar(s.last_tick)}
${siteRow("All projects", "", collecting(s), [period([...keywords.flatMap((r) => r.checks), ...clicksOver.map((m) => m.date), ...mentionsOver.map((m) => m.date)])])}
${banner}
${all.length ? main : ""}
${projects}`,
    )
  }

  /** Changes between consecutive page_watch snapshots of the last weeks, newest first. */
  const pageDiffs = (projectId: string) => {
    const watch = collectors.get("page_watch")
    if (!watch) return []
    const from = new Date(now().getTime() - PAGE_DIFF_DAYS * 86_400_000).toISOString()
    const bySubject = Map.groupBy(signals.query(projectId, "page_watch", undefined, { from }), (s) => s.subject)
    return [...bySubject.values()]
      .flatMap((snaps) =>
        snaps.slice(0, -1).flatMap((cur, i) => watch.diff(snaps[i + 1]!.payload, cur.payload).map((c) => ({ at: cur.captured_at, ...c }))),
      )
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, PAGE_DIFFS)
  }


  /** The Keywords card: positions with a bar that grows as the rank improves, and AI Overviews. */
  const keywordsCard = (domain: string, ranks: Outcomes["ranks"]) => {
    const { rows: kws, checked, firstChecked } = ranks
    if (kws.length === 0)
      return card("Keywords", "kw", [["Keywords", empty("No tracked keywords. Run <code>/gtmkit:gtm-keywords</code> in Claude Code to pick them, then <code>gtmkit tick</code> checks their positions weekly (serp_top30).")]])
    if (!checked) return card("Keywords", "kw", [["Keywords", empty("No check has run yet. <code>gtmkit tick</code> checks the top 30 for each tracked keyword weekly (serp_top30).")]])
    const current = (r: (typeof kws)[number]) => (r.ranking ? r.points.at(-1)!.value : r.checked ? 100 : 101)
    const sorted = [...kws].sort((a, b) => current(a) - current(b))
    // The change against the check just before. Back after a gap, or new: a neutral chip, as no change is known.
    const change = (r: (typeof kws)[number]) => {
      if (!r.ranking || !r.prevCheck) return ""
      const prev = r.points.at(-2)
      if (prev?.date === r.prevCheck) return deltaChip(r.points.at(-1)!.value - prev.value, "lower", "", true)
      return `<span class="chip">${prev ? "Back in top 30" : "New in top 30"}</span>`
    }
    const positions = sorted.map((r) => {
      const cur = r.points.at(-1)
      const best = r.points.length ? Math.min(...r.points.map((m) => m.value)) : null
      // The best position is shown only when it is not the current one.
      const bestText = best !== null && !(r.ranking && best === cur!.value) ? `<span class="muted">best ${num(best)}</span>` : ""
      const value = r.ranking ? `${bestText}<b>${num(cur!.value)}</b>${change(r)}` : `${bestText}<span class="muted">${r.checked ? "Not in top 30" : "Not checked yet"}</span>`
      return { label: esc(r.name), value, w: r.ranking ? (31 - cur!.value) / 30 : 0 }
    })
    // The mark repeats the word beside it, so it is hidden from screen readers.
    const mark = (on: boolean) => `<span class="mk${on ? " on" : ""}" aria-hidden="true"></span>`
    const overview = sorted.map((r) => {
      const aio = r.aio === undefined ? '<span class="muted">Not checked</span>' : r.aio ? `${mark(true)}Shown` : '<span class="muted">Not shown</span>'
      const cited = r.aio ? `${mark(r.cited === 1)}${r.cited === 1 ? "Cited" : '<span class="muted">Not cited</span>'}` : '<span class="muted">–</span>'
      return { label: esc(r.name), value: `<span class="c2">${aio}</span><span class="c2">${cited}</span>` }
    })
    const when = firstChecked === checked ? day(checked) : `${day(firstChecked)} to ${day(checked)}`
    return card(
      "Keywords",
      "kw",
      [
        ["Positions", rows("Keyword", "Position", positions)],
        ["AI Overview", rows("Keyword", '<span class="c2">AI Overview</span><span class="c2">Site cited</span>', overview)],
      ],
      `Checked ${esc(when)}`,
    )
  }

  /** The AI answers card: share of voice, the answer per prompt and engine, and crawler access. */
  const answersCard = (p: Project, domain: string, answers: Answer[], tracked: Answer[]) => {
    const competitors = [
      ...new Set([...p.competitors.map(bareDomain), ...answers.flatMap((a) => [...a.now.keys()].filter((k) => k.startsWith("mentioned:")).map((k) => k.slice(10)))]),
    ]
    const voices = [{ name: domain, key: "mentioned", own: true }, ...competitors.map((c) => ({ name: c, key: `mentioned:${c}`, own: false }))].map((v) => ({
      ...v,
      n: tracked.filter((a) => a.now.get(v.key) === 1).length,
    }))
    const top = Math.max(1, ...voices.map((v) => v.n))
    const sov = tracked.length
      ? rows(
          "Name",
          "Share of tracked answers",
          [voices[0]!, ...voices.slice(1).sort((a, b) => b.n - a.n)].map((v) => ({
            label: `<span>${esc(v.name)}${v.own && p.brand_names[0] ? `<span class="sub">${esc(p.brand_names[0])}</span>` : ""}</span>`,
            value: `<span>${((v.n / tracked.length) * 100).toFixed(0)}% <span class="muted">${v.n} of ${tracked.length}</span></span>`,
            w: v.n / top,
            cls: v.own ? "own" : "",
          })),
        )
      : empty(
          p.prompts.length
            ? "No answers to the tracked prompts yet. <code>gtmkit tick</code> asks ChatGPT and Perplexity each tracked prompt weekly (ai_visibility)."
            : "No tracked prompts. Add the questions your buyers ask to the project, then <code>gtmkit tick</code> asks ChatGPT and Perplexity each week (ai_visibility).",
        )
    const engines = [...new Set(answers.map((a) => a.engine))].sort((a, b) => (ENGINES.indexOf(a) + 1 || 99) - (ENGINES.indexOf(b) + 1 || 99))
    const prompts = [...new Set([...p.prompts, ...answers.map((a) => a.prompt)])]
    // Two marks per answer: a circle for a mention of the brand, a square for a citation of the site.
    const mark = (shape: string, on: boolean, yes: string, no: string) =>
      `<span class="mk ${shape}${on ? " on" : ""}" title="${on ? yes : no}"><span class="sr">${on ? yes : no}</span></span>`
    const matrix = answers.length
      ? `<table class="matrix"><thead><tr><th>Prompt</th>${engines.map((e) => `<th>${esc(ENGINE_LABEL[e] ?? e)}</th>`).join("")}</tr></thead><tbody>${prompts
          .map(
            (prompt) =>
              `<tr><td class="text">${esc(prompt)}</td>${engines
                .map((engine) => {
                  const a = answers.find((x) => x.engine === engine && x.prompt === prompt)
                  return `<td data-l="${esc(ENGINE_LABEL[engine] ?? engine)}">${a ? `${mark("m", a.now.get("mentioned") === 1, "Mentioned", "Not mentioned")}${mark("c", a.now.get("cited") === 1, "Cited", "Not cited")}` : '<span class="muted" title="Not asked">–<span class="sr">Not asked</span></span>'}</td>`
                })
                .join("")}</tr>`,
          )
          .join("")}</tbody></table>
<p class="mlgd"><span><i class="mk m on"></i>Mentions the brand</span><span><i class="mk c on"></i>Cites ${esc(domain)}</span><span><i class="mk m"></i><i class="mk c"></i>Does not</span></p>`
      : empty("No answers yet.")
    const access = metrics(p.id, "ai_access", { subject: domain })
    const latest = lastTwo(access).now
    const llms = latest.get("llms_txt")
    const crawlers = access.length
      ? `${rows("Crawler", "robots.txt", [
          ...[...latest]
            .filter(([k]) => k.startsWith("allowed:"))
            .map(([k, v]) => ({ label: esc(k.slice(8)), value: v ? '<span class="chip up dot">Allowed</span>' : '<span class="chip solid-down">Blocked</span>' })),
          { label: "llms.txt", value: llms === 1 ? '<span class="chip up dot">Present</span>' : `<span class="chip line">${llms === undefined ? "Unknown" : "Missing"}</span>` },
        ])}<p class="foot">From robots.txt on ${esc(domain)}, checked ${esc(day(maxDate(access)))}: a crawler counts as allowed when it may fetch the home page.</p>`
      : empty("No check yet. <code>gtmkit tick</code> reads robots.txt and llms.txt weekly (ai_access).")
    return card(
      "AI answers",
      "ai",
      [
        ["Share of voice", sov],
        ["By prompt", matrix],
        ["Crawlers", crawlers],
      ],
      answers.length ? `${answers.length} answers, latest ${esc(day(maxDate(answers)))}` : "",
    )
  }

  const actionRow = (a: ListedAction, domain: string) => {
    const d = a.delta
    // The measured delta sits on the title line at the right, before the status badge. One meta line under it.
    const outcome = a.status === "done" && d ? `<span class="d"><span>${esc(num(d.baseline))} to ${esc(num(d.current))}</span>${deltaChip(d.delta, direction(a.target.key, domain))}</span>` : ""
    const meta = [
      `<span title="${esc(`${a.target.kind} / ${a.target.subject} / ${a.target.key}`)}">Target: ${esc(targetText(a.target, domain))}</span>`,
      `based on ${a.evidence.length === 1 ? "snapshot" : "snapshots"} ${esc(a.evidence.join(" and "))}`,
      a.status === "done" && !d ? "delta 4 weeks after done" : "",
      a.shared_target ? "shares its target with another done action, so neither delta is its alone" : "",
    ]
      .filter(Boolean)
      .join(", ")
    return `<li class="${esc(a.status)}"><span class="t">${esc(a.title)}</span><span class="rt">${outcome}<span class="badge ${esc(a.status)}">${esc(cap1(a.status))}</span></span><span class="meta">${meta}</span></li>`
  }

  const actionsCard = (p: Project, domain: string) => {
    const list = actions.list(p.id).sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
    if (list.length === 0) return card("Actions", "ac", [["Actions", empty("No actions yet. The weekly brief proposes them with evidence, and <code>actions_update</code> records your decision.")]])
    const note = '<p class="foot">Deltas appear 4 weeks after an action is done. A delta is not proof: other changes can explain it.</p>'
    const tab = (label: string, of: ListedAction[], foot = "") =>
      [`${label} <span class="n">${of.length}</span>`, of.length ? `<ul class="actions">${of.map((a) => actionRow(a, domain)).join("")}</ul>${foot}` : empty(`No ${label.toLowerCase()} actions.`)] as [string, string]
    // One list, open first, then done, then dropped, and a tab per status.
    return card("Actions", "ac", [
      tab("All", list, list.some((a) => a.status === "done") ? note : ""),
      tab(
        "Open",
        list.filter((a) => a.status === "proposed" || a.status === "accepted"),
      ),
      tab(
        "Done",
        list.filter((a) => a.status === "done"),
        note,
      ),
      tab(
        "Dropped",
        list.filter((a) => a.status === "dropped"),
      ),
    ])
  }

  const backlinksCard = (p: Project, domain: string) => {
    const bySubject = Map.groupBy(metrics(p.id, "backlinks_summary"), (m) => m.subject)
    if (bySubject.size === 0)
      return card("Backlinks", "bl", [["Backlinks", empty("No backlink data. Run <code>/gtmkit:gtm-competitors</code> in Claude Code: it collects backlinks_summary for the site and its competitors, fresh for 30 days.")]])
    const latest = [...bySubject].map(([subject, ms]) => ({ subject, ms, v: lastTwo(ms) }))
    const tab = (key: string, label: string): [string, string] => {
      const has = latest.filter((x) => x.v.now.has(key)).sort((a, b) => b.v.now.get(key)! - a.v.now.get(key)!)
      const top = Math.max(1, ...has.map((x) => x.v.now.get(key)!))
      return [
        label,
        rows(
          "Domain",
          label,
          has.map((x) => {
            const own = x.subject === domain
            const prev = own ? x.v.prev?.get(key) : undefined
            return {
              label: `<span>${esc(x.subject)}${own ? '<span class="sub">your site</span>' : ""}</span>`,
              value: `${esc(count(x.v.now.get(key)!))}${prev === undefined ? "" : deltaChip(x.v.now.get(key)! - prev, "higher")}`,
              w: x.v.now.get(key)! / top,
              cls: own ? "own" : "",
            }
          }),
        ),
      ]
    }
    return card("Backlinks", "bl", [tab("referring_domains", "Referring domains"), tab("backlinks", "Backlinks")], `Checked ${esc(day(maxDate([...bySubject.values()].flat())))}`)
  }

  /** "+2 / −1 lines", or "+1 line" and "−2 lines" when the other side is zero. */
  const lineCount = (added: number, removed: number) => {
    const n = (k: number) => `${k} ${k === 1 ? "line" : "lines"}`
    return removed === 0 ? `+${n(added)}` : added === 0 ? `−${n(removed)}` : `+${added} / −${removed} lines`
  }

  /** A page change: its line counts, then the first added lines with a plus and removed with a minus. */
  const changeRow = (d: ReturnType<typeof pageDiffs>[number]) => {
    const [added, removed] = [d.added ?? [], d.removed ?? []]
    const side = (lines: string[], cls: string, mark: string, label: string) =>
      lines
        .slice(0, PAGE_LINES)
        .map((l) => `<li class="${cls}"><span aria-hidden="true">${mark}</span><span class="sr">${label}: </span>${esc(l)}</li>`)
        .join("")
    return `<li><div class="ch"><time datetime="${esc(d.at)}">${esc(day(d.at))}</time><span class="u" title="${esc(d.subject)}">${esc(d.subject.replace(/^https?:\/\//, ""))}</span><span class="cnt">${lineCount(added.length, removed.length)}</span></div><ul class="lines">${side(added, "add", "+", "Added")}${side(removed, "del", "−", "Removed")}</ul></li>`
  }

  const changesCard = (p: Project) => {
    const diffs = pageDiffs(p.id)
    return card(
      "Page changes",
      "pc",
      [
        [
          "Page changes",
          diffs.length
            ? `<ol class="changes">${diffs.slice(0, PAGE_CHANGES_SHOWN).map(changeRow).join("")}</ol>${
                diffs.length > PAGE_CHANGES_SHOWN
                  ? `<details class="more"><summary>Show all ${diffs.length}</summary><ol class="changes">${diffs.slice(PAGE_CHANGES_SHOWN).map(changeRow).join("")}</ol></details>`
                  : ""
              }`
            : empty(
                p.urls.length
                  ? `No changes in the last 5 weeks on ${p.urls.length} watched ${p.urls.length === 1 ? "page" : "pages"}.`
                  : "No watched pages. Add your own or competitor URLs to the project, and <code>gtmkit tick</code> fetches them weekly (page_watch).",
              ),
        ],
      ],
      diffs.length ? "Last 5 weeks" : "",
    )
  }

  const project = (p: Project) => {
    const s = signals.status()
    const status = s.projects.find((x) => x.id === p.id)
    const o = outcomes(p)
    const { domain, ranks } = o
    const kws = ranks.rows
    const brief = actions.latestBrief(p.id)
    const gsc = gscOf(p)
    const topOn = (r: (typeof kws)[number], d: string | undefined) => r.points.some((m) => m.date === d && m.value <= 3)
    const top3 = kws.filter((r) => topOn(r, r.checked)).length
    const top3Prev = kws.some((r) => r.prevCheck) ? kws.filter((r) => topOn(r, r.prevCheck)).length : null
    const noGsc = empty("No Search Console data yet. Once Google credentials are set (see the README), <code>gtmkit tick</code> collects gsc_performance weekly.")
    const gscStat = (key: string, label: string, format: (n: number) => string, opts: Parameters<typeof trend>[3]): Stat => {
      const points = gsc.get(key) ?? []
      const cur = points.at(-1)?.value
      const prev = points.at(-2)?.value
      const d = cur === undefined || prev === undefined ? null : key === "position" ? Math.round((cur - prev) * 10) / 10 : cur - prev
      return {
        label,
        value: cur === undefined ? '<small class="muted">no data</small>' : esc(format(cur)),
        delta: deltaChip(d, direction(key, "")),
        view: trend(label, points, format, opts) || noGsc,
      }
    }
    const pts = o.prevAnswers ? Math.round((o.mentioned / o.tracked.length) * 100) - Math.round((o.prevMentioned / o.prevAnswers) * 100) : null
    const mentionsOver = shareOver([p])
    const charted = kws.some((r) => r.points.length > 0)
    const noRanks = empty(
      kws.length === 0
        ? "No tracked keywords. Run <code>/gtmkit:gtm-keywords</code> in Claude Code to pick them."
        : charted
          ? ""
          : ranks.checked
            ? `${esc(domain)} is not in the top 30 for any tracked keyword yet.`
            : "No check has run yet. <code>gtmkit tick</code> checks the top 30 for each tracked keyword weekly (serp_top30).",
    )
    const main = mainCard("m", "Overview", [
      {
        label: "Page one keywords",
        value: kws.length ? `${ranks.onPage}<small> of ${kws.length}</small>` : '<small class="muted">none tracked</small>',
        delta: ranks.onPagePrev === null ? "" : deltaChip(ranks.onPage - ranks.onPagePrev, "higher"),
        view: charted ? `<div data-hl>${ladder(kws)}</div>` : noRanks,
      },
      {
        label: "Top 3 keywords",
        value: kws.length ? `${top3}<small> of ${kws.length}</small>` : '<small class="muted">none tracked</small>',
        delta: top3Prev === null ? "" : deltaChip(top3 - top3Prev, "higher"),
        view: trend("Keywords in the top 3", countOver(kws, (v) => v <= 3), count, { id: "t-top3" }) || noRanks,
      },
      gscStat("clicks", "Clicks", count, { id: "t-clicks" }),
      gscStat("impressions", "Impressions", count, { id: "t-impr" }),
      gscStat("position", "Avg. position", (n) => n.toFixed(1), { invert: true, whole: false, id: "t-pos" }),
      {
        label: "AI mentions",
        value: o.tracked.length ? share(o.mentioned, o.tracked.length) : '<small class="muted">no answers</small>',
        delta: pts === null ? "" : deltaChip(pts, "higher", " pts"),
        view: trend("Answers that mention the brand", mentionsOver, (n) => `${n}%`, { id: "t-ai" }) || empty("No answers to the tracked prompts yet."),
      },
    ])
    const briefBody = brief
      ? `<div class="brief">${briefHtml(brief.markdown, brief.period)}</div>`
      : empty("No brief yet. <code>gtmkit tick</code> writes one each week with the gtm-brief playbook. Run <code>/gtmkit:gtm-brief</code> in Claude Code for one now.")
    const dates = [...kws.flatMap((r) => r.checks), ...(gsc.get("clicks") ?? []).map((m) => m.date), ...mentionsOver.map((m) => m.date)]
    return page(
      `${p.id} - gtmkit`,
      `${topBar(s.last_tick, { month: s.month, spent: s.global.spent_usd, cap: s.global.cap_usd })}
${siteRow(esc(p.id), esc(domain), collecting(s), [`${esc(usd(status?.spent_usd ?? 0))} of ${esc(usd(status?.cap_usd ?? null))}<span class="wide"> this month</span>`, period(dates)])}
${main}
<div class="cols"><div class="col">${keywordsCard(domain, ranks)}
${actionsCard(p, domain)}
${changesCard(p)}</div>
<div class="col">${card("Brief", "br", [["Brief", briefBody]], brief ? esc(brief.period) : "")}
${answersCard(p, domain, o.answers, o.tracked)}
${backlinksCard(p, domain)}</div></div>`,
    )
  }

  return { index, project }
}
