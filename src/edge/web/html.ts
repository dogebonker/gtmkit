import { CSS } from "./styles"

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]!)

const finite = (n: number | null | undefined): n is number => n != null && Number.isFinite(n)
export const num = (n: number | null | undefined) => (!finite(n) ? "" : Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(1))
export const usd = (n: number | null) => (n === null ? "no cap" : finite(n) ? `$${n.toFixed(2)}` : "")
export const count = (n: number) => (finite(n) ? Math.round(n).toLocaleString("en-US") : "")

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** "2026-11-09" or an ISO time as "9 Nov". */
export const day = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""}`
/** An ISO time as "16 Nov 2026, 09:00 UTC". */
export const moment = (iso: string) => `${day(iso)} ${iso.slice(0, 4)}, ${iso.slice(11, 16)} UTC`
export const monthName = (ym: string) =>
  ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][
    Number(ym.slice(5, 7)) - 1
  ] ?? ym

/** Which way is better for a metric key, or null when it names another domain or has no clear direction. */
export const direction = (key: string, domain: string): "lower" | "higher" | null => {
  if (key === "position" || key === `position:${domain}` || key === "issues") return "lower"
  if (HIGHER.has(key) || key.startsWith("allowed:")) return "higher"
  return null
}
const HIGHER = new Set(["clicks", "impressions", "mentioned", "cited", "ai_overview", "ai_overview_cited", "referring_domains", "backlinks", "llms_txt"])

/**
 * A change as a chip by its meaning: an arrow up in green when it got better, down in red when worse, "no change" as
 * muted text for none. A position going from 5 to 3 is "improved 2". With no direction the chip is neutral and signed.
 * Screen readers get a hidden "better" or "worse" only where the visible text does not already say it. `short` shows
 * the arrow and number only, with the word hidden and in the title, for dense rows.
 */
export const deltaChip = (d: number | null | undefined, better: "lower" | "higher" | null, unit = "", short = false) => {
  if (!finite(d)) return ""
  if (d === 0) return short ? '<span class="muted nc" title="no change">\u2013<span class="sr"> no change</span></span>' : '<span class="muted nc">no change</span>'
  const tone = judge(d, better)
  if (!tone) return `<span class="chip">${d > 0 ? "+" : "\u2212"}${esc(num(Math.abs(d)))}${unit}</span>`
  const good = tone === "up"
  const figure = `${esc(num(Math.abs(d)))}${unit}`
  if (short) {
    const word = better === "lower" ? (good ? "improved" : "worse") : good ? "better" : "worse"
    return `<span class="chip ${tone}" title="${word} ${figure}">${good ? "\u2191" : "\u2193"} ${figure}<span class="sr"> ${word}</span></span>`
  }
  const said = better === "lower" ? (good ? "improved " : "worse ") : ""
  return `<span class="chip ${tone}">${good ? "\u2191" : "\u2193"} ${said}${figure}${said ? "" : `<span class="sr"> ${good ? "better" : "worse"}</span>`}</span>`
}

/** "up" when a change of `d` is better, "down" when worse, "" when there is none or no direction. */
const judge = (d: number, better: "lower" | "higher" | null) =>
  d === 0 || better === null ? "" : (better === "lower" ? d < 0 : d > 0) ? "up" : "down"

// The only script: hover and focus on a ranking line or its label emphasises it, and charts get a crosshair, a dot on
// each line at the cursor date and a tooltip 14px right of the crosshair (left of it only when it would overflow),
// kept inside the plot. Stat and tab switching is CSS (radio inputs). It reads escaped data-* attributes and writes
// text nodes only. The pages read fine without it.
export const SCRIPT = `(()=>{
const mark=(root,key)=>{root.classList.toggle("hl",key!=null);for(const el of root.querySelectorAll("[data-s]"))el.classList.toggle("on",el.dataset.s===key)};
for(const root of document.querySelectorAll("[data-hl]")){
const pick=e=>{const t=e.target.closest("[data-s]");mark(root,t?t.dataset.s:null)};
root.addEventListener("pointerover",pick);root.addEventListener("focusin",pick);
root.addEventListener("pointerleave",()=>mark(root,null));
root.addEventListener("focusout",e=>{if(!root.contains(e.relatedTarget))mark(root,null)});}
for(const fig of document.querySelectorAll("[data-xs]")){
const plot=fig.querySelector(".plot"),tip=fig.querySelector(".tip"),xh=fig.querySelector(".xh");
const xs=fig.dataset.xs.split("|").map(Number),ds=fig.dataset.ds.split("|");
const series=[...fig.querySelectorAll("[data-v]")].map(el=>({el,name:el.dataset.name||"",v:el.dataset.v.split("|"),y:(el.dataset.y||"").split("|"),cur:el.querySelector(".cur"),tone:el.classList.contains("hi")?"hi":el.classList.contains("fall")?"fall":""}));
const hide=()=>fig.classList.remove("xon");
plot.addEventListener("pointerleave",hide);
plot.addEventListener("pointermove",e=>{
const r=plot.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*1000;let i=0;
for(let j=1;j<xs.length;j++)if(Math.abs(xs[j]-x)<Math.abs(xs[i]-x))i=j;
xh.setAttribute("x1",xs[i]);xh.setAttribute("x2",xs[i]);
for(const s of series)if(s.cur)s.cur.setAttribute("d",s.y[i]?"M"+xs[i]+" "+s.y[i]+"h0":"");
const head=document.createElement("b");head.textContent=ds[i];tip.replaceChildren(head);
for(const s of series.filter(s=>s.v[i]!=="").sort((a,b)=>Number(a.v[i])-Number(b.v[i])||0)){
const row=document.createElement("span");row.className=(s.tone+(s.el.classList.contains("on")?" on":"")).trim();
const d=document.createElement("u");const n=document.createElement("i");n.textContent=s.name;const v=document.createElement("em");v.textContent=s.v[i];
row.append(d,n,v);tip.append(row);}
const px=xs[i]/1000*r.width,tw=tip.offsetWidth,th=tip.offsetHeight;
const left=px+14+tw>r.width?px-14-tw:px+14,top=Math.max(0,Math.min(r.height-th,e.clientY-r.top-th/2));
tip.style.transform="translate("+left+"px,"+top+"px)";
fig.classList.add("xon");});}
})()`

export const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title>` +
  `<link rel="preload" href="/fonts/geist.woff2" as="font" type="font/woff2" crossorigin>` +
  `<style>${CSS}</style></head><body><div class="wrap">${body}</div><script>${SCRIPT}</script></body></html>`
