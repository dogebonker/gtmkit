import type { Metric } from "../../signals"
import { day, esc, num } from "./html"

// Charts are inline SVG stretched over the plot (preserveAspectRatio none, x and y in 0..1000) with non-scaling
// strokes, and all text is HTML placed in percent, so the plot can change size per screen and labels keep their size.
// Dots are zero-length round-capped paths, which stay round when the plot stretches.
const NS = `preserveAspectRatio="none" aria-hidden="true"`
const VE = `vector-effect="non-scaling-stroke"`
const PAD = 30
// The ladder's CSS height (styles.ts), used to place labels in pixels before they are written as percents.
const LADDER_PX = 320
/** One label line plus the gap to the next. */
const LABEL_PX = 20
const LADDER_MAX = 12
const X_STEP = 2

/** x of each date in 0..1000, with one date in the middle. */
const xsOf = (n: number, inset = 16) => Array.from({ length: n }, (_, i) => (n === 1 ? 500 : inset + (i / (n - 1)) * (1000 - 2 * inset)))
const f1 = (n: number) => n.toFixed(1)
const pct = (permille: number) => `${f1(permille / 10)}%`
const dot = (x: number, y: number) => `<path class="pt" d="M${f1(x)} ${f1(y)}h0" ${VE}/>`
/** The dot the script moves to the cursor's date, from the series' data-y. */
const CUR = `<path class="cur" d="" ${VE}/>`

/** A line through the values present, broken at a null. An undefined date (not checked) is stepped over. */
const pathOf = (xs: number[], ys: (number | null | undefined)[]) => {
  let d = ""
  let pen = false
  ys.forEach((y, i) => {
    if (y === undefined) return
    if (y === null) pen = false
    else {
      d += `${pen ? "L" : "M"}${f1(xs[i]!)} ${f1(y)}`
      pen = true
    }
  })
  return d
}

/** Every second date (every fourth past 16 dates), counted back from the last, or on from the first with `fromStart`. */
const tickIndexes = (n: number, fromStart = false) => {
  const step = n > 16 ? 2 * X_STEP : X_STEP
  return Array.from({ length: n }, (_, i) => i).filter((i) => (fromStart ? i : n - 1 - i) % step === 0)
}

/**
 * Date labels centred on their points: `picks` on a desktop (class "dk"), and four evenly spaced from the first date
 * to the last on a phone (class "ph"). A label at the plot's edge is aligned inwards, so it stays inside the card.
 */
const xAxis = (xs: number[], dates: string[], picks: number[]) => {
  const n = dates.length
  const phone = [...new Set([0, 1, 2, 3].map((k) => Math.round((k * (n - 1)) / 3)))]
  const span = (i: number, cls: string) =>
    `<span class="${cls}${xs[i]! <= 20 ? " e0" : xs[i]! >= 980 ? " e1" : ""}" style="left:${pct(xs[i]!)}">${esc(day(dates[i]!))}</span>`
  return `<div class="xax" aria-hidden="true">${picks.map((i) => span(i, "dk")).join("")}${phone.map((i) => span(i, "ph")).join("")}</div>`
}

/**
 * A chart's values as a visually hidden table: its text equivalent for screen readers and with scripts off. The table
 * sits in a clipped div, as a table ignores a 1px width and would widen the page.
 */
const dataTable = (caption: string, dates: string[], cols: { name: string; values: string[] }[]) =>
  `<div class="sr"><table><caption>${esc(caption)}</caption><thead><tr><th scope="col">Date</th>${cols.map((c) => `<th scope="col">${esc(c.name)}</th>`).join("")}</tr></thead><tbody>${dates
    .map((d, i) => `<tr><th scope="row">${esc(day(d))}</th>${cols.map((c) => `<td>${esc(c.values[i] ?? "")}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`

/** Spread label centres so neighbours do not overlap (each `size` tall) inside [0, max], each near its wish. */
const spread = (wish: number[], size: number, max: number) => {
  const order = wish.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y)
  order.forEach((o, k) => {
    const prev = order[k - 1]
    o.y = Math.max(o.y, prev ? prev.y + size : size / 2)
  })
  for (let k = order.length - 1; k >= 0; k--) {
    const o = order[k]!
    const next = order[k + 1]
    o.y = Math.min(o.y, next ? next.y - size : max - size / 2)
  }
  // When the labels cannot all fit, they overlap at the top rather than leave the chart.
  for (const o of order) o.y = Math.max(o.y, size / 2)
  const out: number[] = []
  for (const o of order) out[o.i] = o.y
  return out
}

interface RankSeries {
  /** Links the line, its label and its table row. */
  key: string
  name: string
  points: Metric[]
  /** False when the latest check found the site outside the top 30. */
  ranking: boolean
  /** The dates this keyword was checked. A date it was not checked on does not break its line. */
  checks: string[]
}

/**
 * The rank ladder: positions 1 to 30 with 1 at the top, the top 3 and page one shaded. Lines are quiet grey, except
 * the best 3 keywords now (amber) and the one that lost most places over the range (red). Each line ends in a one-line
 * label. At most the 12 best current positions are charted, plus the biggest drop when it is not among them. On a
 * phone the labels leave the plot and every charted keyword is named under it.
 * `given` is every tracked keyword, so the caption counts against the Keywords card.
 */
export const ladder = (given: RankSeries[]) => {
  const finite = given.map((s) => ({ ...s, points: s.points.filter((p) => Number.isFinite(p.value)) })).filter((s) => s.points.length > 0)
  const fall = (s: RankSeries) => s.points.at(-1)!.value - s.points[0]!.value
  const now = (s: RankSeries) => (s.ranking ? s.points.at(-1)!.value : Infinity)
  const byNow = [...finite].sort((a, b) => now(a) - now(b))
  const leaders = byNow.filter((s) => s.ranking).slice(0, 3)
  const drop = byNow.filter((s) => s.ranking && !leaders.includes(s) && fall(s) > 0).sort((a, b) => fall(b) - fall(a))[0]
  const kept = new Set(byNow.slice(0, LADDER_MAX))
  if (drop) kept.add(drop)
  const series = byNow.filter((s) => kept.has(s))
  const tone = (s: RankSeries) => (leaders.includes(s) ? "hi" : s === drop ? "fall" : "")
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort()
  // The first and last dates sit on the plot's edges, so the first date label starts at the left edge.
  const xs = xsOf(dates.length, 0)
  const y = (pos: number) => PAD + ((pos - 1) / 29) * (1000 - 2 * PAD)
  const rows = series.map((s) => {
    const at = new Map(s.points.map((p) => [p.date, p.value]))
    const checked = new Set(s.checks)
    const values = dates.map((d) => at.get(d) ?? (checked.has(d) ? null : undefined))
    const lastIdx = values.findLastIndex((v) => v != null)
    return { s, values, lastIdx, last: values[lastIdx]!, lastY: y(values[lastIdx]!) }
  })
  const picks = tickIndexes(dates.length, true)
  // Quiet lines first, so the emphasised ones are drawn on top.
  const weight = (s: RankSeries) => (leaders.includes(s) ? 2 : s === drop ? 1 : 0)
  const order = rows.map((r, i) => ({ r, i })).sort((a, b) => weight(a.r.s) - weight(b.r.s))
  const paths = order
    .map(({ r, i }) => {
      const lead = r.s.ranking ? `<path class="lead" d="M${f1(xs[r.lastIdx]!)} ${f1(r.lastY)}H1000" ${VE}/>` : ""
      const ys = r.values.map((v) => (v == null ? "" : f1(y(v))))
      return `<g class="series ${tone(r.s)}" data-s="${r.s.key}" data-name="${esc(r.s.name)}" data-v="${r.values.map((v) => num(v)).join("|")}" data-y="${ys.join("|")}">${lead}<path class="ln draw" style="--i:${i}" d="${pathOf(xs, r.values.map((v) => (v == null ? v : y(v))))}" ${VE}/>${dot(xs[r.lastIdx]!, r.lastY)}${CUR}</g>`
    })
    .join("")
  const hline = (cls: string, at: number) => `<line class="${cls}" x1="0" x2="1000" y1="${f1(at)}" y2="${f1(at)}" ${VE}/>`
  const svg = `<svg viewBox="0 0 1000 1000" ${NS}><rect class="band3" x="0" y="0" width="1000" height="${f1(y(3.5))}"/><rect class="band" x="0" y="${f1(y(3.5))}" width="1000" height="${f1(y(10.5) - y(3.5))}"/>${hline("grid-l", y(20))}${hline("axis", y(30))}${hline("edge1", y(10.5))}${hline("edge3", y(3.5))}${paths}<line class="xh" x1="0" x2="0" y1="0" y2="1000" ${VE}/></svg>`
  const at = spread(
    rows.map((r) => ((r.s.ranking ? r.lastY : 1000 - PAD) / 1000) * LADDER_PX),
    LABEL_PX,
    LADDER_PX,
  ).map((v) => (v / LADDER_PX) * 1000)
  const connectors = rows
    .map((r, i) => (r.s.ranking ? `<path class="lead" data-s="${r.s.key}" d="M0 ${f1(r.lastY)}C10 ${f1(r.lastY)} 10 ${f1(at[i]!)} 20 ${f1(at[i]!)}" ${VE}/>` : ""))
    .join("")
  const pill = (r: (typeof rows)[number]) => `<b class="pill">${r.s.ranking ? num(r.last) : "out"}</b>`
  const title = (r: (typeof rows)[number]) => (r.s.ranking ? `${r.s.name}: position ${num(r.last)}` : `${r.s.name}: not in the top 30 on the latest check`)
  const cls = (r: (typeof rows)[number]) => [tone(r.s), r.s.ranking ? "" : "out"].filter(Boolean).join(" ")
  const labels = rows
    .map((r, i) => `<li data-s="${r.s.key}"${cls(r) ? ` class="${cls(r)}"` : ""} style="--yd:${pct(at[i]!)}" tabindex="0" title="${esc(title(r))}">${pill(r)}<span>${esc(r.s.name)}</span></li>`)
    .join("")
  // On a phone the labels leave the plot: every charted keyword is named under it, best position first.
  const key = rows.map((r) => `<li${cls(r) ? ` class="${cls(r)}"` : ""} title="${esc(title(r))}">${pill(r)}<span>${esc(r.s.name)}</span></li>`).join("")
  const ticks = [1, 10, 20, 30].map((p) => `<span style="top:${pct(y(p))}">${p}</span>`).join("")
  const legend = [
    `<span><i class="sw band3"></i>Positions 1 to 3</span>`,
    `<span><i class="sw band"></i>Page one, 1 to 10</span>`,
    leaders.length ? `<span><i class="sw hi"></i>Best ${leaders.length} now</span>` : "",
    drop ? `<span><i class="sw fall"></i>Biggest drop</span>` : "",
    series.length < given.length ? `<span>${series.length} of ${given.length} keywords charted, all in the Keywords card</span>` : "",
  ].join("")
  return `<figure class="ladder" data-xs="${xs.map(f1).join("|")}" data-ds="${esc(dates.map(day).join("|"))}">
<figcaption class="lgd">${legend}</figcaption>
<div class="yax" aria-hidden="true">${ticks}</div>
<div class="plot">${svg}<div class="tip" aria-hidden="true"></div></div>
<svg class="lc" viewBox="0 0 20 1000" ${NS}>${connectors}</svg>
<ol class="ll">${labels}</ol>
${xAxis(xs, dates, picks)}
<ol class="key">${key}</ol>
${dataTable(
  "Google position of each charted keyword by date",
  dates,
  rows.map((r) => ({ name: r.s.name, values: r.values.map((v) => (v === null ? "not in top 30" : num(v))) })),
)}
</figure>`
}

/** Round value ticks over [lo, hi], from 0 when `zero`, whole steps when `whole`, 6 or 7 lines like the reference. */
const ticksOf = (lo: number, hi: number, zero: boolean, whole: boolean) => {
  const from = zero ? Math.min(0, lo) : lo
  const raw = (hi - from) / 6 || 1
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  const step = Math.max((m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p, whole ? 1 : 0)
  const a = Math.floor(from / step) * step
  const b = Math.max(Math.ceil(hi / step) * step, a + step)
  return Array.from({ length: Math.round((b - a) / step) + 1 }, (_, k) => a + k * step)
}

/**
 * One series as the large area chart of the main card: round value ticks with gridlines at the left, dates under it,
 * a thin line over a soft gradient and a crosshair with a tooltip. `invert` puts lower values up (positions).
 */
export const trend = (
  name: string,
  given: Metric[],
  format: (n: number) => string,
  { invert = false, zero = true, whole = true, id = "t" }: { invert?: boolean; zero?: boolean; whole?: boolean; id?: string } = {},
) => {
  const points = given.filter((p) => Number.isFinite(p.value))
  if (points.length === 0) return ""
  const xs = xsOf(points.length, 0)
  const values = points.map((p) => p.value)
  const ticks = ticksOf(Math.min(...values), Math.max(...values), zero && !invert, whole)
  const [a, b] = [ticks[0]!, ticks.at(-1)!]
  const yOf = (v: number) => ((invert ? v - a : b - v) / (b - a)) * 1000
  const line = pathOf(xs, values.map(yOf))
  const area = points.length > 1 ? `<path class="fill" fill="url(#${id})" d="${line}L${f1(xs.at(-1)!)} 1000L${f1(xs[0]!)} 1000Z"/>` : ""
  const grid = ticks.map((v) => `<line class="${yOf(v) >= 999 ? "axis" : "grid-l"}" x1="0" x2="1000" y1="${f1(yOf(v))}" y2="${f1(yOf(v))}" ${VE}/>`).join("")
  return `<figure class="trend" data-xs="${xs.map(f1).join("|")}" data-ds="${esc(points.map((p) => day(p.date)).join("|"))}">
<div class="yax" aria-hidden="true">${ticks.map((v) => `<span style="top:${pct(yOf(v))}">${esc(format(v))}</span>`).join("")}</div>
<div class="plot"><svg viewBox="0 0 1000 1000" ${NS}><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="g0"/><stop offset="1" class="g1"/></linearGradient></defs>${grid}<g class="hi" data-name="${esc(name)}" data-v="${esc(values.map(format).join("|"))}" data-y="${values.map((v) => f1(yOf(v))).join("|")}">${area}<path class="ln draw" d="${line}" ${VE}/>${points.length === 1 ? dot(xs[0]!, yOf(values[0]!)) : ""}${CUR}</g><line class="xh" x1="0" x2="0" y1="0" y2="1000" ${VE}/></svg><div class="tip" aria-hidden="true"></div></div>
${xAxis(xs, points.map((p) => p.date), tickIndexes(points.length, true))}
${dataTable(name, points.map((p) => p.date), [{ name, values: values.map(format) }])}
</figure>`
}
