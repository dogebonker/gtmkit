# AGENTS.md

Notes for coding agents working in this repository. User-facing documentation is in [README.md](README.md). The design and its decisions are in [docs/design.md](docs/design.md): read section 8 before changing behaviour.

## What this is

One Bun program with one SQLite file. It buys SEO and GEO data from DataForSEO and Google, stores it, and serves it to an agent over MCP. The program never calls a model. The agent is always the client.

## Commands

```sh
bun install
bun run check       # lint, typecheck and tests. Run this before you report work as done.
bun run test        # tests only (bun --bun vp test run)
bun run lint        # oxlint, including the module import rules
bun run typecheck   # tsc --noEmit
```

Do not run `bun run eval` unless asked. It starts real headless `claude -p` runs on the owner's subscription.

## Layout

| Path | Holds |
|---|---|
| `src/projects` | Project profile and tracked keywords, prompts and URLs |
| `src/signals` | Collection, snapshots, spend ledger, caps, digest, reconciliation |
| `src/signals/collectors` | One file per signal kind. The registry finds each file. |
| `src/actions` | Proposed actions with evidence, deltas, briefs |
| `src/edge` | Adapters: `mcp`, `cli`, `web` (dashboard), `cloud` (public server) |
| `plugin/skills` | Playbooks. Each is also served as an MCP prompt. |
| `eval` | Brief eval: fixture, grader, runner |
| `test` | Tests, with fake providers in `test/fake-provider.ts` |

## Rules that must hold

- **Module direction.** `projects`, `signals` and `actions` never import `src/edge`. `projects` imports neither of the others. `actions` uses only the `signals` interface. `vite.config.ts` enforces this through lint. Do not relax those rules.
- **Every paid call passes the cap check.** A provider call happens only after `prepare()` in `src/signals/index.ts` has claimed the snapshot, checked the caps and written a `spend` row in one `BEGIN IMMEDIATE` transaction. Do not add a path around it.
- **`estimate` is an upper bound.** It returns a finite number of USD that the real charge cannot exceed. Prices are in `src/signals/prices.ts`. Every collector sets a result limit, so its payload stays under 200 KB.
- **`spend` is append-only.** Triggers forbid deletes and allow `actual_usd` to be set once. Do not work around them.
- **Caps are set from a terminal only.** No MCP tool and no non-interactive path may write to the `caps` table, except the `halt:` rows that `signals` writes.
- **Provider and page text is untrusted.** Store it in `payload.items` or payload metadata. It may reach the agent only through `mark()` in `src/edge/mcp/server.ts`, in fields named `untrusted_*`. The dashboard escapes it.
- **Pages are fetched only through `src/signals/fetcher.ts`.** It checks the resolved address and every redirect. Do not call `fetch` on a URL from a profile or a provider.
- **Credentials never go in the database, the logs or the repository.**

## Adding a signal kind

Add one file in `src/signals/collectors/` that default-exports a `Collector` (see `src/signals/collector.ts`). No other source file needs to change. Data that `fetch` stores but does not send goes under `params.keep`, which is left out of the snapshot key. Then add the kind to the tables in `README.md` and `docs/design.md`.

## Tests

- Write the failing test first. Extend the closest existing test file before you add a new one.
- Tests use fake DataForSEO and Google endpoints behind the real clients, never the network. A test that runs `runDue` must pass a fake page fetcher.
- Set the clock with `GTMKIT_NOW`. Set `GTMKIT_HOME` to a temporary directory. Never read or write `~/.gtmkit`.
- `GTMKIT_LAUNCH_AGENTS_DIR` redirects `gtmkit schedule`, so tests never call `launchctl`.
- Never make a check pass by skipping or deleting a test, adding a lint suppression, or loosening an assertion.

## Conventions

- TypeScript on Bun, with Effect for provider calls and zod for MCP tool inputs. Add no dependency without asking.
- Smallest change that works. A deliberate shortcut with a known ceiling carries a `ponytail:` comment that names the ceiling.
- No schema change without a new migration in `src/db.ts`. Existing migrations are never edited.
- Provider facts not yet checked against a live account are marked "unverified" in `docs/design.md`. Keep that marking accurate.
