import { lookup as dnsLookup, type LookupAddress } from "node:dns"
import http from "node:http"
import https from "node:https"
import { isIP } from "node:net"
import { Effect } from "effect"
import { ProviderError } from "./http"

export interface Page {
  /** The URL after redirects. */
  url: string
  status: number
  body: string
  /** True when the body passed MAX_BYTES and was cut off there. */
  truncated: boolean
}

/** Guarded GET of one public http(s) page. */
export type FetchPage = (url: string) => Effect.Effect<Page, ProviderError>

const MAX_HOPS = 5
const MAX_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 15_000

// Loopback, private, link-local, carrier-grade NAT, IPv4-mapped and their IPv6 equivalents,
// plus "this network", IETF protocol assignments, documentation, benchmarking, multicast and reserved space,
// NAT64 (well-known and local-use), Teredo and 6to4 (all embed IPv4 addresses).
const BLOCKED = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/3",
  "::/96",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "2001::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
]

const v4 = (a: string): bigint => a.split(".").reduce((n, p) => (n << 8n) | BigInt(Number(p)), 0n)

const v6 = (a: string): bigint => {
  let s = a.toLowerCase().replace(/%.*$/, "")
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted) {
    const n = v4(dotted[2]!)
    s = `${dotted[1]}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`
  }
  const [head = "", tail] = s.split("::")
  const h = head ? head.split(":") : []
  const t = tail ? tail.split(":") : []
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t]
  return groups.reduce((n, g) => (n << 16n) | BigInt(Number.parseInt(g, 16)), 0n)
}

const RANGES = BLOCKED.map((cidr) => {
  const [base = "", bits = ""] = cidr.split("/")
  const family = isIP(base)
  const width = family === 4 ? 32n : 128n
  const shift = width - BigInt(bits)
  return { family, shift, prefix: (family === 4 ? v4(base) : v6(base)) >> shift }
})

/** True for anything that is not a public unicast address, including non-IP strings. */
export const isBlockedAddress = (address: string): boolean => {
  const family = isIP(address)
  if (family === 0) return true
  const n = family === 4 ? v4(address) : v6(address)
  return RANGES.some((r) => r.family === family && n >> r.shift === r.prefix)
}

class Refused extends Error {}

/**
 * Resolve, check every address, and hand only checked addresses to the socket. node:http connects to what
 * `lookup` returns, so the address checked is the address connected to (no second DNS answer to rebind to).
 */
const guardedLookup =
  (blocked: (address: string) => boolean) =>
  (
    hostname: string,
    options: { all?: boolean },
    callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) =>
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, "")
      const bad = addresses.find((a) => blocked(a.address))
      if (bad || addresses.length === 0) {
        return callback(new Refused(`refused: ${hostname} resolves to ${bad?.address ?? "nothing"}`), "")
      }
      if (options.all) return callback(null, addresses)
      callback(null, addresses[0]!.address, addresses[0]!.family)
    })

const checkUrl = (url: URL, blocked: (address: string) => boolean) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Refused(`refused: ${url.protocol} is not http or https`)
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (isIP(host) && blocked(host)) throw new Refused(`refused: ${host} is not a public address`)
}

interface Hop {
  status: number
  location?: string
  body: string
  truncated: boolean
}

const getOnce = (url: URL, signal: AbortSignal, blocked: (address: string) => boolean) =>
  new Promise<Hop>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http
    const req = client.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup(blocked) as never,
        signal,
        headers: { "user-agent": "gtmkit-page-watch", accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
      },
      (res) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        if (status >= 300 && status < 400 && location) {
          // Close the socket: draining a redirect's body would read an endless one forever.
          res.destroy()
          return resolve({ status, location, body: "", truncated: false })
        }
        const chunks: Buffer[] = []
        let size = 0
        const done = (truncated: boolean) => resolve({ status, body: Buffer.concat(chunks).toString("utf8"), truncated })
        res.on("data", (chunk: Buffer) => {
          if (size + chunk.length < MAX_BYTES) {
            chunks.push(chunk)
            size += chunk.length
            return
          }
          chunks.push(chunk.subarray(0, MAX_BYTES - size))
          size = MAX_BYTES
          done(true)
          req.destroy()
        })
        res.on("end", () => done(false))
        res.on("error", reject)
      },
    )
    req.on("error", reject)
    req.end()
  })

// Bun's node:http runs on its fetch, which sends a request through HTTP_PROXY or HTTPS_PROXY when set and offers no
// per-request opt-out (agent, agent: false and proxy: "" all still use it). The proxy would connect to an address
// that was never checked, so page fetches refuse instead. ALL_PROXY is refused too in case a runtime starts using it.
// ponytail: refuses under any proxy variable. A direct node:net client if page fetches must work behind a proxy.
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].flatMap((v) => [v, v.toLowerCase()])

export const createPageFetcher =
  (blocked: (address: string) => boolean = isBlockedAddress): FetchPage =>
  (start) =>
    Effect.tryPromise({
      try: async (signal) => {
        const proxy = PROXY_VARS.find((v) => process.env[v])
        if (proxy) throw new Refused(`refused: ${proxy} is set, and a page fetch through a proxy would skip the address check`)
        let url = new URL(start)
        for (let hop = 0; ; hop++) {
          checkUrl(url, blocked)
          const r = await getOnce(url, signal, blocked)
          if (r.location === undefined) {
            if (r.status < 200 || r.status >= 300) {
              throw new ProviderError({ message: `page ${url.href}: HTTP ${r.status}`, retryable: r.status >= 500, status: r.status })
            }
            return { url: url.href, status: r.status, body: r.body, truncated: r.truncated }
          }
          if (hop === MAX_HOPS) throw new Refused(`refused: more than ${MAX_HOPS} redirects`)
          // A fixed message: the Location header is attacker-chosen text.
          const next = URL.parse(r.location, url.href)
          if (!next) throw new Refused("refused: bad redirect location")
          url = next
        }
      },
      catch: (cause) => {
        if (cause instanceof ProviderError) return cause
        const message = cause instanceof Error ? cause.message : String(cause)
        // A refusal can come back wrapped by the HTTP client, so it is recognised by its message too.
        const refused = cause instanceof Refused || message.startsWith("refused:")
        return new ProviderError({ message: `page ${start}: ${message}`, retryable: !refused })
      },
    }).pipe(
      Effect.timeout(TIMEOUT_MS),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(new ProviderError({ message: `page ${start}: timed out after ${TIMEOUT_MS / 1000} s` })),
      ),
    )

export const fetchPage: FetchPage = createPageFetcher()
