// DataForSEO live prices in USD, the only place they are written down.
// Source: dataforseo.com/pricing (DataForSEO Labs, SERP, AI Optimization / LLM Responses), read 2026-11-14,
// dataforseo.com/pricing/on-page/onpage-api and dataforseo.com/pricing/backlinks/backlinks, read 2026-11-14.
// Not yet checked against a real account (slice S0). A reported cost above an estimate halts the kind.
export const PRICES = {
  labsTask: 0.012,
  labsItem: 0.00012,
  serpLivePer10: 0.002, // Google organic live, per 10 results of depth
  llmTask: 0.0006, // LLM Responses live, plus what the model charges
  // DataForSEO passes on the model provider's charge per answer, which it does not publish. Assumed ceilings per engine,
  // unverified (S0). Each request sends max_output_tokens 2048, Gemini and Claude also use_reasoning false; nothing in
  // the request limits searches, and with web search the output may pass 2048 tokens. Model prices are the providers'.
  // chatgpt (gpt-4.1-mini, web search): $0.02, the design's assumption (section 6). 2,048 output tokens at $1.60 per
  //   million is $0.0033; the web search fee and search input tokens are unknown and not bounded by the request.
  // perplexity (sonar): $0.02, the design's assumption. 2,048 output tokens at $1 per million is $0.002, plus a $0.005
  //   to $0.012 request fee by search context size and the input tokens. The only engine whose output cap holds.
  // gemini (gemini-2.5-flash, web search): $0.035 per grounded prompt + 2,048 output tokens at $2.50 per million
  //   ($0.0051) = $0.0401, rounded up to $0.05: the rest pays for about 3,900 tokens past the output cap.
  // claude (claude-haiku-4-5, web search): 5 searches at $0.01 + 40,000 input tokens at $1 per million + 2,048 output
  //   tokens at $5 per million ($0.0102) = $0.1002, rounded up to $0.12: the rest pays for 4,000 tokens past the cap.
  llmModelMax: { chatgpt: 0.02, perplexity: 0.02, gemini: 0.05, claude: 0.12 },
  onPageInstant: 0.00015, // On-Page Instant Pages live, per page, without JavaScript, resources or browser rendering
  backlinksTask: 0.024, // every /backlinks/* endpoint, live
  backlinksRow: 0.000036,
} as const

/** Upper bound for one Labs live task that returns at most `limit` items. */
export const labsEstimate = (limit: number): number => PRICES.labsTask + PRICES.labsItem * limit
