import { readdirSync } from "node:fs"
import type { Collector } from "./collector"

// Every .ts file in ./collectors is a collector. Adding a kind needs no edit here.
const dir = new URL("./collectors/", import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))

export const collectors: ReadonlyMap<string, Collector> = new Map(
  await Promise.all(
    files.map(async (f) => {
      const c = (await import(new URL(f, dir).href)).default as Collector
      return [c.kind, c] as const
    }),
  ),
)
