// DataForSEO live prices in USD, the only place they are written down.
// Source: dataforseo.com/pricing (DataForSEO Labs, SERP, AI Optimization / LLM Responses), read 2026-11-14,
// dataforseo.com/pricing/on-page/onpage-api and dataforseo.com/pricing/backlinks/backlinks, read 2026-11-14.
// Not yet checked against a real account (slice S0). A reported cost above an estimate halts the kind.
export const PRICES = {
  labsTask: 0.012,
  labsItem: 0.00012,
  serpLivePer10: 0.002, // Google organic live, per 10 results of depth
  llmTask: 0.0006, // LLM Responses live, plus what the model charges
  // The model's charge is not published. Design assumption (section 6): $0.02 per answer at most.
  llmModelMax: 0.02,
  onPageInstant: 0.00015, // On-Page Instant Pages live, per page, without JavaScript, resources or browser rendering
  backlinksTask: 0.024, // every /backlinks/* endpoint, live
  backlinksRow: 0.000036,
} as const

/** Upper bound for one Labs live task that returns at most `limit` items. */
export const labsEstimate = (limit: number): number => PRICES.labsTask + PRICES.labsItem * limit
