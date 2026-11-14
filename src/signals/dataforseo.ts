import { Effect, Schema } from "effect"
import { type Fetch, ProviderError, requestJson } from "./http"

export { ProviderError, type Fetch } from "./http"

export interface ProviderResult<A = unknown> {
  result: A
  costUsd: number | undefined
}

export interface DataForSEO {
  /**
   * One live call: POST a single task to `path` and decode its result. A failure after the provider reported a cost,
   * a task error or a result that does not decode, carries that cost.
   */
  <A>(
    path: string,
    task: Record<string, unknown>,
    decode: (result: unknown) => Effect.Effect<A, { message: string }>,
  ): Effect.Effect<ProviderResult<A>, ProviderError>
  /** Account balance in USD. Free call. */
  balance: () => Effect.Effect<number, ProviderError>
}

const BASE_URL = "https://api.dataforseo.com"
const OK = 20000
const TIMEOUT_MS = 125_000

// docs.dataforseo.com/v3/appendix/errors: status_code 20000 is success, at the top level and per task.
const Envelope = Schema.Struct({
  status_code: Schema.Number,
  status_message: Schema.String,
  cost: Schema.optional(Schema.NullOr(Schema.Number)),
  tasks: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          status_code: Schema.Number,
          status_message: Schema.String,
          result: Schema.optional(Schema.Unknown),
        }),
      ),
    ),
  ),
})
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope)

// docs.dataforseo.com/v3/appendix/user_data: result[0].money.balance is the money left in the account.
// The endpoint exposes no total spent, so reconciliation works from the balance drop.
const UserData = Schema.Array(Schema.Struct({ money: Schema.Struct({ balance: Schema.Number }) }))
const decodeUserData = Schema.decodeUnknownEffect(UserData)

export const dataForSEO = (
  credentials: { login: string; password: string },
  fetchFn: Fetch = fetch,
  timeoutMs = TIMEOUT_MS,
): DataForSEO => {
  const send = (method: "GET" | "POST", path: string, body?: unknown) =>
    requestJson(
      fetchFn,
      `DataForSEO ${path}`,
      BASE_URL + path,
      {
        method,
        headers: {
          authorization: `Basic ${btoa(`${credentials.login}:${credentials.password}`)}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      timeoutMs,
    ).pipe(
      Effect.flatMap((body) =>
        decodeEnvelope(body).pipe(
          Effect.mapError((e) => new ProviderError({ message: `DataForSEO ${path}: bad response: ${e.message}` })),
        ),
      ),
      Effect.flatMap((env) => {
        const first = env.tasks?.[0]
        if (env.status_code !== OK || !first || first.status_code !== OK) {
          const s = first ?? env
          return Effect.fail(
            new ProviderError({
              message: `DataForSEO ${path}: ${s.status_code} ${s.status_message}`,
              retryable: s.status_code >= 50000, // DataForSEO's internal errors, the 5xx of its own codes
              costUsd: env.cost ?? undefined,
            }),
          )
        }
        return Effect.succeed({ result: first.result, costUsd: env.cost ?? undefined })
      }),
    )

  const call = <A>(path: string, task: Record<string, unknown>, decode: (result: unknown) => Effect.Effect<A, { message: string }>) =>
    send("POST", path, [task]).pipe(
      Effect.flatMap(({ result, costUsd }) =>
        decode(result).pipe(
          Effect.mapError((e) => new ProviderError({ message: `DataForSEO ${path}: bad result: ${e.message}`, costUsd })),
          Effect.map((decoded) => ({ result: decoded, costUsd })),
        ),
      ),
    )
  const balance = () =>
    send("GET", "/v3/appendix/user_data").pipe(
      Effect.flatMap(({ result }) => decodeUserData(result)),
      Effect.mapError((e) =>
        e instanceof ProviderError ? e : new ProviderError({ message: `DataForSEO user_data: bad response: ${e.message}` }),
      ),
      Effect.flatMap((r) =>
        r[0] ? Effect.succeed(r[0].money.balance) : Effect.fail(new ProviderError({ message: "DataForSEO user_data: empty result" })),
      ),
    )
  return Object.assign(call, { balance })
}

/** Domain without scheme, `www.` or path, as Labs `target` fields expect. */
export const bareDomain = (domain: string): string =>
  domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")

/** Optional, nullable provider field. */
export const maybe = <S extends Schema.Top>(s: S) => Schema.optional(Schema.NullOr(s))
