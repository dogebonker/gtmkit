# gtmkit

Local SEO and GEO (generative engine optimization) analytics for your own projects: keyword, competitor and backlink research and on-page audits, plus weekly history (Search Console, top 30 SERP with AI Overviews, visibility in AI answers, AI crawler access, competitor pages), bought from DataForSEO and Google, stored in one SQLite file, with hard monthly spend caps. Claude Code is the client. The program never calls Claude. Each week a headless Claude run turns the data into a stored brief and evidence-backed actions, and done actions report how their target metric moved. A read-only dashboard on 127.0.0.1 shows trends, briefs and actions. The same program runs in a container for other people, who connect their own agent over HTTP (see [Cloud](#cloud)). Design: [docs/design.md](docs/design.md). Notes for coding agents: [AGENTS.md](AGENTS.md).

## Setup

Needs Bun 1.3+, Claude Code and a DataForSEO account (minimum top-up $50, auto top-up off).

```sh
bun install
bun link            # puts `gtmkit` on your PATH
gtmkit init         # creates ~/.gtmkit, asks for DataForSEO API login/password and the global and default caps
claude --plugin-dir ./plugin
```

Then, in the repo of the project you want to research, run `/gtmkit:gtm-onboard`. It writes `.gtmkit.json` with the project id. Run `gtmkit schedule install` to collect history every day the machine is awake.

Credentials live in `~/.gtmkit/credentials` (mode 0600) or in the environment, which wins per provider. They are never stored in the database. `GTMKIT_HOME` moves the whole `~/.gtmkit` directory.

- Claude, for the weekly brief: `claude -p` uses your subscription login. If it cannot read it (for example under launchd), run `claude setup-token` and put the token in the credentials file as `"CLAUDE_CODE_OAUTH_TOKEN"`, or set that variable. `tick` never passes `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` to `claude`. `GTMKIT_CLAUDE_BIN` replaces the `claude` binary.
- DataForSEO: `gtmkit init` writes `{"dataforseo": {"login", "password"}}`, or set `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`.
- Search Console, one of:
  - a service account added as a user on the property: put its key file's `client_email` and `private_key` under `"google": {"service_account": {...}}`, or set `GOOGLE_APPLICATION_CREDENTIALS` to the key file's path;
  - a personal OAuth desktop client: `"google": {"oauth": {"client_id", "client_secret", "refresh_token"}}`, or set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`. The scope is `webmasters.readonly`.

  The property is `sc-domain:<domain>`, or the URL-prefix property when the project's domain is stored as a URL such as `https://example.com/`.

## Commands

| Command | What it does |
|---|---|
| `gtmkit init` | Create `~/.gtmkit`, store credentials, set the global and default monthly caps. Terminal only. |
| `gtmkit budget` | Change the global and default monthly caps (USD). Terminal only. |
| `gtmkit budget --project <id>` | Set one project's monthly cap. Terminal only. |
| `gtmkit budget --clear-halt` | Clear `halt:<kind>` rows written when a reported cost was above its estimate. Fix `src/signals/prices.ts` first. Terminal only. |
| `gtmkit mcp` | MCP server on stdio. The plugin's `.mcp.json` starts it. |
| `gtmkit mcp --brief-only` | MCP server with only `project_get`, `signals_query`, `digest`, `actions_list`, `actions_propose` and `brief_save`, and no provider credentials. |
| `gtmkit tick` | Collect every weekly kind that has no snapshot this ISO week, for every project. A kind whose whole due set does not fit the caps is skipped for the week. Before and after, compares the DataForSEO balance drop with the spend ledger: any excess is added to the ledger and writes `halt:all`. Then, for each project with no brief this week, runs the `gtm-brief` playbook headless: `claude -p <playbook> --tools "" --strict-mcp-config --mcp-config <gtmkit mcp --brief-only> --allowedTools "mcp__gtmkit__*" --output-format stream-json --verbose`, at most 15 minutes, transcript in `~/.gtmkit/logs/brief-<project>-<time>.jsonl`. |
| `gtmkit schedule install` | Write `~/Library/LaunchAgents/com.gtmkit.tick.plist` with your current `PATH` and load it: `gtmkit tick` daily at 09:00, and on wake if that time was missed. Log: `~/.gtmkit/logs/tick.log`. On Linux, run `gtmkit tick` from cron instead. |
| `gtmkit schedule uninstall` | Unload and remove the job. |
| `gtmkit status` | Last tick, halts, this month's spend against the caps, this week's coverage per project and kind, the latest brief per project, and the action acceptance rate: accepted and done over accepted, done and dropped. |
| `gtmkit brief <project>` | Print the latest brief of a project. |
| `gtmkit rebuild-metrics` | Recompute the `metrics` table from the stored snapshots. |
| `gtmkit serve [--port <n>]` | Read-only dashboard at `http://127.0.0.1:8787` (`--port 0` picks a free port). No login, so it binds 127.0.0.1 only and answers only requests whose `Host` is that address. Pages: projects with this month's spend against the caps, halts and this week's coverage; per project the position, Search Console, AI visibility and backlink trends, the latest brief, the actions with their deltas, and page changes of the last 5 weeks. Stored text is HTML-escaped, the brief is shown as plain text, the pages run no script, and the database connection is query-only. |
| `gtmkit serve --public [--port <n>]` | Container mode on `0.0.0.0:8787`: MCP over streamable HTTP, the dashboard behind a login, `/health`, and `runDue()` daily. See [Cloud](#cloud). |

No MCP tool can change a cap. A project without its own cap uses the default cap. With no global or no default cap, every collection is refused.

## MCP tools

`project_get`, `project_upsert`, `signals_collect` (with `dry_run`), `signals_query`, `digest`, `actions_propose`, `actions_update`, `actions_list`, `brief_save`. Provider rows come back as text in `untrusted_provider_data`, at most 2,000 characters per row. `digest` returns, per kind, up to 20 changes in a week against the latest earlier snapshot (each in `untrusted_change`, with `evidence`: the two snapshot ids) and the coverage: subjects collected of subjects tracked. Missing data counts as unknown, not as a change.

- `project_upsert` without `id` creates a project with a generated id. A given id has 1 to 64 characters from `a-z`, `0-9` and `-`, starts with a letter or digit, and is not `global`, `default` or anything starting with `halt`: ids share a namespace with the cap scopes.
- `actions_propose` stores a proposed action. It is rejected unless every evidence id is a stored snapshot of that project and the target metric (kind, subject, key, as in the metrics table) is named.
- `actions_update` records the owner's decision: `proposed` to `accepted` or `dropped`, `accepted` to `done` or `dropped`. `done` records the time and the target's baseline: its latest value on or before that day.
- `actions_list` returns every action. Four weeks after `done_at`, a done action carries its baseline, the current value and the delta, labelled a delta, not proof, and `shared_target` when another done action has the same target.
- `brief_save` stores a project's weekly brief (markdown) for an ISO week.

| Kind | Subject | Schedule | Metrics |
|---|---|---|---|
| `keyword_ideas` | seed topic | 30 days | none |
| `keyword_volume` | tracked keywords (one Labs `keyword_overview` call) | 30 days | `volume`, `difficulty` |
| `competitor_keywords` | competitor domain | 30 days | `ranked_keywords` |
| `keyword_gap` | competitor domain | 30 days | `gap_keywords` |
| `gsc_performance` | project domain: the 7 days ending 3 days before the run, top 1,000 queries | weekly, free | `clicks`, `impressions`, `position` per query and in total |
| `serp_top30` | tracked keyword | weekly | `position:<domain>` for the project and each competitor in the top 30; `ai_overview` (0 or 1), `ai_overview_cited` and `ai_overview_cited:<competitor>` (0 or 1: the domain is among the AI Overview's references) |
| `ai_visibility` | `<engine>: <prompt>` for each tracked prompt, engines `chatgpt` and `perplexity`; `gemini` and `claude` on demand only (name the engine in the subject) until their cost is measured | weekly | `mentioned`, `cited`, `mentioned:<competitor>`, `cited:<competitor>` (0 or 1) |
| `ai_access` | project domain: `/robots.txt` and `/llms.txt` through the page fetcher | weekly, free | `allowed:<bot>` (0 or 1: may the bot fetch the root path `/`) for GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot and Google-Extended, `llms_txt` (0 or 1, none when llms.txt answered 429 or 5xx) |
| `page_watch` | watched URL, text up to 200 KB | weekly, free | `changed_chars` |
| `backlinks_summary` | domain: the project's (the default) or a competitor's (Backlinks `summary` live) | 30 days | `referring_domains`, `backlinks` |
| `site_audit` | page URL of the project's site (On-Page Instant Pages live), on demand only | 7 days | `issues`: the page's failed on-page checks |

`ai_access` treats a robots.txt that answers 401 or 403 as no restrictions (RFC 9309), so a firewall that blocks the fetcher reads as "allowed". A robots.txt answering 429 or 5xx fails the snapshot.

`signals_collect` for `site_audit` with no subject reads `https://<domain>/sitemap.xml` (following a sitemap index, at most 10 files) through the page fetcher, keeps the first 100 pages of the project's domain, and collects each one not audited in the last 7 days as its own snapshot. The whole set is refused when its estimate does not fit the caps.

Pages are fetched over http or https only, with each of at most 5 redirects re-checked, a 15 s timeout and a 2 MB cap. Loopback, private, link-local, carrier-grade NAT, IPv4-mapped and the IPv6 equivalents are refused, and the socket connects only to the address that was checked. Page fetches refuse to run while `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` (either case) is set: Bun would send them through the proxy, which connects to an address nobody checked. Unset those for `gtmkit` to use `page_watch`, `ai_access` and `site_audit`.

## Plugin skills

`/gtmkit:gtm-onboard`, `/gtmkit:gtm-keywords`, `/gtmkit:gtm-competitors` (ranked keywords, keyword gap and backlinks), `/gtmkit:gtm-audit [url ...]` (on-page audit of up to 100 sitemap pages), `/gtmkit:gtm-brief` (the weekly brief `tick` also runs), `/gtmkit:gtm-content-brief <keyword>`, `/gtmkit:gtm-geo` (AI crawler access, AI answers and AI Overviews, with proposed actions).

## Cloud

One container per owner runs `gtmkit serve --public`: one process, one SQLite file, no Claude. Build and run it:

```sh
docker build -t gtmkit .
docker run -d --name gtmkit -p 8787:8787 -v gtmkit-data:/data \
  -e GTMKIT_TOKEN="$(openssl rand -hex 32)" \
  -e DATAFORSEO_LOGIN=... -e DATAFORSEO_PASSWORD=... \
  gtmkit
docker exec -it gtmkit gtmkit budget   # set the global and default caps: nothing is collected until you do
```

| Environment variable | Meaning |
|---|---|
| `GTMKIT_TOKEN` | Required, at least 32 characters. The bearer token for `/mcp` and the dashboard login. Without it `--public` refuses to start. |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | DataForSEO credentials. |
| `GOOGLE_APPLICATION_CREDENTIALS` (a key file mounted into the container), or `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Search Console, optional. |
| `GTMKIT_HOME` | `/data` in the image. The database is `/data/gtmkit.db`: mount a volume there. |

The image holds no secret and the database holds no credential. Do not run `gtmkit init` in the container: it writes a credentials file to the volume.

- **Endpoints.** `/mcp`: MCP over streamable HTTP, `Authorization: Bearer <GTMKIT_TOKEN>` required, otherwise 401. `/login`: a form that takes the token and sets an `HttpOnly; Secure; SameSite=Strict` cookie holding an HMAC derived from the token, not the token. Every dashboard page without that cookie answers 401 with the login form. `/health`: no auth, `{"ok":true}` (200) when the database opens and its migrations are current, `{"ok":false}` (503) otherwise, nothing else. Tokens and cookies are compared in constant time. Changing `GTMKIT_TOKEN` logs every browser out.
- **TLS and Host.** The process speaks plain HTTP. TLS is terminated by the platform's proxy: expose only the proxy's `https://` address. The `Secure` cookie is not sent back over plain `http://` except to localhost. The Host header is not checked in public mode, since every route except `/health` needs the token or the cookie. Local `gtmkit serve` keeps its loopback bind and Host check.
- **Schedule.** The server calls `runDue()` at start and then 24 hours after each run ends, so runs never overlap and a failed run is logged and retried the next day. It never writes a brief: no model runs in the container. Ask your agent for `gtm-brief` each week.
- **All nine MCP tools** are served. Caps still cannot be set over MCP: run `docker exec -it <container> gtmkit budget` (or `--project <id>`, `--clear-halt`). It refuses without a terminal, so `docker exec` without `-it` is refused too.
- **Playbooks as MCP prompts.** The server serves the seven playbooks from `plugin/skills` as prompts, so no plugin is needed. Each takes one optional `arguments` string, which replaces `$ARGUMENTS`.

Connect Claude Code (name the server `gtmkit`, so the prompts appear as `/gtmkit:gtm-onboard (MCP)` and so on):

```sh
claude mcp add --transport http gtmkit https://gtmkit.example.com/mcp \
  --header "Authorization: Bearer $GTMKIT_TOKEN"
```

or in `.mcp.json`, with the token from your environment:

```json
{ "mcpServers": { "gtmkit": { "type": "http", "url": "https://gtmkit.example.com/mcp", "headers": { "Authorization": "Bearer ${GTMKIT_TOKEN}" } } } }
```

## Development

```sh
bun run test        # Vite+ (Vitest) running on Bun: bun --bun vp test run
bun run lint        # oxlint through vp lint, including the module import rules
bun run typecheck   # tsc --noEmit
bun run check       # all three
bun run eval        # 10 brief cases x 3 runs with the real headless claude -p, on your subscription
bun run eval plain 1  # one case, one run
```

Tests use fake DataForSEO and Google endpoints behind the real clients (`test/fake-provider.ts`), set the clock with `GTMKIT_NOW`, and set `GTMKIT_LAUNCH_AGENTS_DIR` so `gtmkit schedule` writes its plist there and never calls `launchctl`.

The eval (`eval/`) builds a frozen fixture database per case from the fake providers, runs the headless brief, and grades the stored actions by code: valid evidence, a target metric, no target of a dropped action, and a stored brief. Transcripts stay in each run's temporary `GTMKIT_HOME`.

Adding a signal kind is one file in `src/signals/collectors/`. The registry finds it.
