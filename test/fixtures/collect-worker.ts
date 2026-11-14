// Runs the 50 collections of the crash test against the fake provider. The test kills it at random points.
import { openDb } from "../../src/db"
import { dbPath } from "../../src/env"
import { createSignals } from "../../src/signals"
import { labsEstimate } from "../../src/signals/prices"
import { fakeDataForSEO } from "../fake-provider"

// Each call is charged exactly the keyword_ideas estimate, so the estimate cannot hide a missing spend row.
const fake = fakeDataForSEO({ chargesFile: process.env.CHARGES_FILE!, chargeUsd: labsEstimate(100), delayMs: () => Math.random() * 30 })
const signals = createSignals(openDb(dbPath()), { dataforseo: fake.dataforseo })

for (let i = 0; i < 50; i++) {
  const r = await signals.collect(process.env.PROJECT_ID!, "keyword_ideas", { subject: `seed ${i}` }, false)
  if (r.status === "refused" || r.status === "failed") throw new Error(r.reason)
}
