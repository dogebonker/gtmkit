import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { GoogleCredentials } from "./signals/google"

export const home = (): string => process.env.GTMKIT_HOME ?? join(homedir(), ".gtmkit")

export const dbPath = (): string => join(home(), "gtmkit.db")

export const credentialsPath = (): string => join(home(), "credentials")

/** Current time. Tests set it with GTMKIT_NOW (ISO 8601). */
export const now = (): Date => (process.env.GTMKIT_NOW ? new Date(process.env.GTMKIT_NOW) : new Date())

export interface Credentials {
  dataforseo?: { login: string; password: string }
  google?: GoogleCredentials
  /** From `claude setup-token`, passed to the headless brief run. */
  CLAUDE_CODE_OAUTH_TOKEN?: string
}

/** Per provider, the environment wins over the credentials file. Never the database. */
export const readCredentials = (): Credentials => {
  const env = process.env
  const fromEnv: Credentials = {}
  if (env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD) {
    fromEnv.dataforseo = { login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD }
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    fromEnv.google = { service_account: JSON.parse(readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, "utf8")) }
  } else if (env.GOOGLE_CLIENT_ID && env.GOOGLE_REFRESH_TOKEN) {
    fromEnv.google = {
      oauth: { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN },
    }
  }
  const path = credentialsPath()
  if (!existsSync(path)) return fromEnv
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} must have mode 0600`)
  return { ...(JSON.parse(readFileSync(path, "utf8")) as Credentials), ...fromEnv }
}
