import { Effect } from "effect"
import { now } from "../../env"
import type { Collector } from "../collector"

// Fetched through the guarded page fetcher (../fetcher.ts). Free.
const TEXT_BYTES = 200_000
const SUMMARY_CHARS = 600

interface Params {
  url: string
}

interface Payload {
  date: string
  url: string
  final_url: string
  truncated: boolean
  items: { text: string }[]
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " }

/** Visible text, one block element per line. */
const toText = (html: string) =>
  html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?(p|div|br|li|h[1-6]|tr|td|th|section|article|header|footer|nav|main|ul|ol|table|title|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e]!)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")

// ponytail: line multiset diff, not an LCS. A moved line counts as unchanged. Good enough to flag a changed page.
const lineDiff = (before: string, after: string) => {
  const left = new Map<string, number>()
  for (const line of before.split("\n")) left.set(line, (left.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of after.split("\n")) {
    const n = left.get(line) ?? 0
    if (n > 0) left.set(line, n - 1)
    else added.push(line)
  }
  const removed = [...left].flatMap(([line, n]) => Array<string>(n).fill(line))
  const chars = (lines: string[]) => lines.reduce((sum, l) => sum + l.length, 0)
  return { added, removed, changedChars: chars(added) + chars(removed) }
}

const textOf = (p: Payload) => p.items[0]?.text ?? ""

const collector: Collector<Params, Payload, "web"> = {
  kind: "page_watch",
  schedule: "weekly",
  provider: "web",
  subjects: (project) => project.urls,
  request: (_project, subject) => {
    if (!subject) throw new Error("page_watch needs a URL as subject")
    const url = new URL(subject)
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("page_watch needs an http or https URL")
    return { subject, params: { url: url.href } }
  },
  estimate: () => 0,
  fetch: (p, web) =>
    web(p.url).pipe(
      Effect.map((page) => ({
        costUsd: 0,
        payload: {
          date: now().toISOString().slice(0, 10),
          url: p.url,
          final_url: page.url,
          truncated: page.truncated,
          items: [{ text: Buffer.from(toText(page.body)).subarray(0, TEXT_BYTES).toString("utf8") }],
        },
      })),
    ),
  extract: (payload, prev) =>
    prev
      ? [{ subject: payload.url, key: "changed_chars", date: payload.date, value: lineDiff(textOf(prev), textOf(payload)).changedChars }]
      : [],
  diff: (prev, cur) => {
    if (!prev) return []
    const d = lineDiff(textOf(prev), textOf(cur))
    if (d.changedChars === 0) return []
    const sample = (lines: string[]) => JSON.stringify(lines.join(" | ").slice(0, SUMMARY_CHARS / 2))
    return [
      {
        subject: cur.url,
        summary: `${cur.url}: ${d.changedChars} chars changed, +${d.added.length}/-${d.removed.length} lines. Added: ${sample(d.added)} Removed: ${sample(d.removed)}`,
        magnitude: d.changedChars,
      },
    ]
  },
}

export default collector
