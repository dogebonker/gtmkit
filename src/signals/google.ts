import { sign } from "node:crypto"
import { Effect, Schema } from "effect"
import { type Fetch, ProviderError, requestJson } from "./http"

/** One of the two, from the credentials file or the environment. */
export interface GoogleCredentials {
  /** A service account key file's fields. The service account must be a user on the Search Console property. */
  service_account?: { client_email: string; private_key: string }
  /** A personal OAuth desktop client and its refresh token. */
  oauth?: { client_id: string; client_secret?: string; refresh_token: string }
}

export interface SearchRow {
  keys: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/** POST one Search Analytics query for `siteUrl` (`sc-domain:example.com` or `https://example.com/`). */
export type SearchConsole = (siteUrl: string, body: Record<string, unknown>) => Effect.Effect<SearchRow[], ProviderError>

// developers.google.com/identity/protocols/oauth2/service-account and .../oauth2/native-app#offline
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
// developers.google.com/webmaster-tools/v1/searchanalytics/query
const QUERY_URL = (siteUrl: string) =>
  `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`
const TIMEOUT_MS = 30_000

const Token = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number })
const Rows = Schema.Struct({
  rows: Schema.optional(
    Schema.Array(
      Schema.Struct({
        keys: Schema.optional(Schema.Array(Schema.String)),
        clicks: Schema.Number,
        impressions: Schema.Number,
        ctr: Schema.Number,
        position: Schema.Number,
      }),
    ),
  ),
})

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url")

const tokenRequest = (creds: GoogleCredentials): URLSearchParams => {
  if (creds.service_account) {
    const iat = Math.floor(Date.now() / 1000)
    const claims = { iss: creds.service_account.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }
    const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`
    const signature = sign("sha256", Buffer.from(input), creds.service_account.private_key)
    return new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${input}.${b64url(signature)}`,
    })
  }
  if (creds.oauth) {
    const { client_id, client_secret, refresh_token } = creds.oauth
    return new URLSearchParams({ grant_type: "refresh_token", client_id, refresh_token, ...(client_secret && { client_secret }) })
  }
  throw new Error("google credentials need service_account or oauth")
}

export const searchConsole = (creds: GoogleCredentials, fetchFn: Fetch = fetch): SearchConsole => {
  let cached: { token: string; until: number } | null = null

  const token = Effect.suspend(() => {
    if (cached && cached.until > Date.now()) return Effect.succeed(cached.token)
    return requestJson(
      fetchFn,
      "Google token",
      TOKEN_URL,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenRequest(creds) },
      TIMEOUT_MS,
    ).pipe(
      Effect.flatMap((body) => Schema.decodeUnknownEffect(Token)(body)),
      Effect.mapError((e) => (e instanceof ProviderError ? e : new ProviderError({ message: `Google token: ${e.message}` }))),
      Effect.map((t) => {
        cached = { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 }
        return t.access_token
      }),
    )
  })

  return (siteUrl, body) =>
    token.pipe(
      Effect.flatMap((accessToken) =>
        requestJson(
          fetchFn,
          "Search Console",
          QUERY_URL(siteUrl),
          {
            method: "POST",
            headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          },
          TIMEOUT_MS,
        ),
      ),
      Effect.flatMap((res) => Schema.decodeUnknownEffect(Rows)(res)),
      Effect.mapError((e) => (e instanceof ProviderError ? e : new ProviderError({ message: `Search Console: ${e.message}` }))),
      Effect.map((r) => (r.rows ?? []).map((row) => ({ ...row, keys: [...(row.keys ?? [])] }))),
    )
}
