import { Data, Effect } from "effect"

/**
 * `retryable`: a network error or a 5xx. A timeout, a 4xx or a bad response is never retryable. `costUsd`: what the
 * provider reported charging for the failed call, when it reported a cost.
 */
export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly message: string
  readonly retryable?: boolean
  readonly costUsd?: number
}> {}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** One JSON request with a timeout. */
export const requestJson = (
  fetchFn: Fetch,
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Effect.Effect<unknown, ProviderError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetchFn(url, { ...init, signal }).catch((e: unknown) => {
        throw new ProviderError({ message: `${label}: ${String(e)}`, retryable: true })
      })
      if (!res.ok) throw new ProviderError({ message: `${label}: HTTP ${res.status}`, retryable: res.status >= 500 })
      return (await res.json()) as unknown
    },
    catch: (cause) => (cause instanceof ProviderError ? cause : new ProviderError({ message: `${label}: ${String(cause)}` })),
  }).pipe(
    Effect.timeout(timeoutMs),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new ProviderError({ message: `${label}: timed out after ${timeoutMs / 1000} s` })),
    ),
  )
