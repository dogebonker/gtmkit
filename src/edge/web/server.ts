import type { Database } from "bun:sqlite"
import { createActions, type ListedAction } from "../../actions"
import { now } from "../../env"
import { getProject, type Project } from "../../projects"
import { bareDomain, collectors, createSignals, GSC_TOTAL, type Metric } from "../../signals"

// Read-only dashboard, server-rendered, no login: it binds 127.0.0.1 only. Every piece of stored text is escaped,
// and the CSP allows no script at all.
const PAGE_DIFF_DAYS = 35
const PAGE_DIFFS = 20
export const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]!)

const num = (n: number | null | undefined) => (n == null ? "" : Number.isInteger(n) ? String(n) : n.toFixed(1))
const signed = (n: number) => (n > 0 ? `+${num(n)}` : num(n))
const usd = (n: number | null) => (n === null ? "no cap" : `$${n.toFixed(2)}`)

const CSS = `
:root{color-scheme:light dark;--bg:light-dark(#fbfbfa,#16181b);--fg:light-dark(#1d1f22,#e6e6e3);--muted:light-dark(#5f636a,#a0a4ab);
--rule:light-dark(#dcdcd8,#30333a);--accent:light-dark(#2f5d8a,#8db4dc);--warn:light-dark(#a33a2a,#ef9a8a);--well:light-dark(#f1f1ee,#1e2125)}
body{margin:0 auto;max-width:72rem;padding:1.5rem 1rem 3rem;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:1.45rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:2.25rem 0 .5rem}
a{color:var(--accent)}a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
p{margin:.25rem 0}.muted{color:var(--muted)}.warn{color:var(--warn)}.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:.35rem .9rem .35rem 0;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-weight:600;color:var(--muted)}.n{text-align:right}td.text{max-width:36rem;overflow-wrap:anywhere}
svg.spark{display:block;color:var(--accent)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:var(--well);padding:1rem;border-radius:4px;max-width:80ch}`

export const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`

const table = (head: string[], rows: string[][], numeric: number[] = []) =>
  rows.length === 0
    ? `<p class="muted">No data yet.</p>`
    : `<div class="scroll"><table><thead><tr>${head.map((h, i) => `<th${numeric.includes(i) ? ' class="n"' : ""}>${h}</th>`).join("")}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.join("")}</tr>`)
        .join("")}</tbody></table></div>`
const td = (v: unknown) => `<td>${esc(v)}</td>`
const tdN = (v: string) => `<td class="n">${esc(v)}</td>`
const tdText = (v: unknown) => `<td class="text">${esc(v)}</td>`

/** A 2px line of one series, higher is better (`invert` flips it for positions). Hover shows the values. */
const spark = (points: Metric[], invert: boolean) => {
  if (points.length < 2) return ""
  const [w, h, pad] = [96, 22, 2]
  const values = points.map((p) => p.value)
  const min = Math.min(...values)
  const span = Math.max(...values) - min || 1
  const xy = points.map((p, i) => {
    const y = ((invert ? p.value - min : min + span - p.value) / span) * (h - 2 * pad) + pad
    return `${((i / (points.length - 1)) * (w - 2 * pad) + pad).toFixed(1)},${y.toFixed(1)}`
  })
  const title = points.map((p) => `${p.date}: ${num(p.value)}`).join("\n")
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="trend"><title>${esc(title)}</title><polyline fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${xy.join(" ")}"/></svg>`
}

/** One row per subject and key: latest value, change against the point before, trend. */
const trends = (metrics: Metric[], invert = (_key: string) => false) => {
  const series = Map.groupBy(metrics, (m) => `${m.subject}\n${m.key}`)
  return table(
    ["Subject", "Metric", "Latest", "Change", "Trend", "Date"],
    [...series.values()].map((points) => {
      const last = points.at(-1)!
      const prev = points.at(-2)
      return [
        tdText(last.subject),
        td(last.key),
        tdN(num(last.value)),
        tdN(prev ? signed(last.value - prev.value) : ""),
        `<td>${spark(points, invert(last.key))}</td>`,
        td(last.date),
      ]
    }),
    [2, 3],
  )
}

const actionRows = (actions: ListedAction[]) =>
  actions.map((a) => [
    tdN(String(a.id)),
    td(a.status),
    tdText(a.title),
    tdText(`${a.target.kind} / ${a.target.subject} / ${a.target.key}`),
    tdN(num(a.delta?.baseline ?? a.baseline)),
    tdN(num(a.delta?.current)),
    tdN(a.delta?.delta == null ? "" : signed(a.delta.delta)),
    td(a.shared_target ? "shared target" : ""),
    td(a.evidence.join(", ")),
  ])

export const dashboard = (db: Database) => {
  const signals = createSignals(db, { dataforseo: null })
  const actions = createActions(db, signals)

  const index = () => {
    const s = signals.status()
    const rows = s.projects.map((p) => {
      const project = getProject(db, p.id)
      const coverage = Object.entries(p.coverage)
        .filter(([, c]) => c.expected > 0)
        .map(([kind, c]) => `${kind} ${c.collected}/${c.expected}`)
        .join(", ")
      return [
        `<td><a href="/p/${esc(encodeURIComponent(p.id))}">${esc(p.id)}</a></td>`,
        td(project?.domain),
        tdN(`${usd(p.spent_usd)} of ${usd(p.cap_usd)}`),
        td(actions.latestBrief(p.id)?.period ?? "none"),
        tdText(coverage),
      ]
    })
    return page(
      "gtmkit",
      `<h1>Projects</h1>
<p>${esc(s.month)} spend: ${esc(usd(s.global.spent_usd))} of global cap ${esc(usd(s.global.cap_usd))}. Last tick: ${esc(s.last_tick ?? "never")}.</p>
<p${s.halts.length ? ' class="warn"' : ""}>Halts: ${esc(s.halts.length ? s.halts.join(", ") : "none")}</p>
<h2>This month and this week</h2>
${table(["Project", "Domain", "Spend", "Latest brief", "Coverage this week"], rows, [2])}`,
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

  const projectPage = (p: Project) => {
    const domain = bareDomain(p.domain)
    const status = signals.status().projects.find((x) => x.id === p.id)
    const brief = actions.latestBrief(p.id)
    const diffs = pageDiffs(p.id)
    return page(
      `${p.id} - gtmkit`,
      `<p><a href="/">All projects</a></p>
<h1>${esc(p.id)}</h1>
<p class="muted">${esc(domain)}. Spend this month: ${esc(usd(status?.spent_usd ?? 0))} of ${esc(usd(status?.cap_usd ?? null))}.</p>
<h2>Positions in the top 30</h2>
${trends(signals.metrics(p.id, "serp_top30", { key: `position:${domain}` }), () => true)}
<h2>Search Console, whole site</h2>
${trends(signals.metrics(p.id, "gsc_performance", { subject: GSC_TOTAL }), (key) => key === "position")}
<h2>AI visibility</h2>
<p class="muted">1 when the answer mentions the brand or cites the site.</p>
${trends(signals.metrics(p.id, "ai_visibility"))}
<h2>Backlinks</h2>
${trends(signals.metrics(p.id, "backlinks_summary"))}
<h2>Latest brief${brief ? `, ${esc(brief.period)}` : ""}</h2>
${brief ? `<pre>${esc(brief.markdown)}</pre>` : `<p class="muted">No brief yet.</p>`}
<h2>Actions</h2>
<p class="muted">Deltas appear 4 weeks after an action is done. A delta is not proof: other changes can explain it.</p>
${table(["#", "Status", "Action", "Target", "Baseline", "Current", "Delta", "", "Evidence"], actionRows(actions.list(p.id)), [0, 4, 5, 6])}
<h2>Recent page changes</h2>
${table(
  ["Captured", "Page", "Change"],
  diffs.map((d) => [td(d.at.slice(0, 10)), tdText(d.subject), tdText(d.summary)]),
)}`,
    )
  }

  return (req: Request): Response => {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405, headers: { allow: "GET, HEAD" } })
    const path = new URL(req.url).pathname
    const html = (body: string, status = 200) => new Response(body, { status, headers: HEADERS })
    if (path === "/") return html(index())
    const m = /^\/p\/([^/]+)$/.exec(path)
    const project = m && getProject(db, decodeURIComponent(m[1]!))
    if (project) return html(projectPage(project))
    return html(page("Not found - gtmkit", `<h1>Not found</h1><p><a href="/">All projects</a></p>`), 404)
  }
}

/**
 * The dashboard on 127.0.0.1, with no login, so any other address is refused. The connection is set query-only:
 * a page cannot write. Requests whose Host is not this loopback address are refused (DNS rebinding).
 */
export const serveDashboard = (db: Database, { hostname = "127.0.0.1", port = 8787 } = {}) => {
  if (hostname !== "127.0.0.1") throw new Error(`refused: gtmkit serve has no login and binds 127.0.0.1 only, not ${hostname}`)
  db.run("PRAGMA query_only = ON")
  const handle = dashboard(db)
  return Bun.serve({
    hostname,
    port,
    fetch: (req, server) => {
      const hosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`]
      if (!hosts.includes(req.headers.get("host") ?? "")) return new Response("refused: unexpected Host header", { status: 403 })
      try {
        return handle(req)
      } catch (e) {
        console.error(e)
        return new Response("internal error, see the gtmkit serve log", { status: 500 })
      }
    },
  })
}
