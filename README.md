# Agent Wars — Secret Keeper

A prompt-engineering game: every player submits a **Defender** prompt (guards a secret) and an
**Attacker** prompt (tries to extract the opponent's secret). Matches are played automatically
by the same LLM under identical limits.

Status: **Phases 1–4 implemented** (engine + league runner, Worker backend, frontend, admin/hardening). Production deploy needs the owner's Cloudflare account — see *Deploy*. Payments (Phase 5) are not started. See `agent-wars-spec.md` §16.

## Requirements

- Node.js ≥ 20 (uses global `fetch` and `crypto.getRandomValues`)
- pnpm 10

```bash
pnpm install
```

## Commands

| Command | What it does |
|---|---|
| `pnpm test` | Vitest unit tests (engine, league runner, word list) — no API key needed |
| `pnpm typecheck` | `tsc --noEmit` (strict) |
| `pnpm validate-words` | Checks `data/words.he.json` (≥ 2000 words, letters א-ת only, 2–8 letters, unique after normalization) |
| `pnpm league` | Runs a round-robin league from `league/submissions.csv` |
| `pnpm build` | Builds the React SPA into `dist/client` (served by the Worker as static assets) |
| `pnpm dev` | `wrangler dev` with local D1 + local queues (http://localhost:8787) — serves the last `pnpm build` |
| `pnpm dev:web` | Vite dev server with hot reload (http://localhost:5173), proxies `/api` to `pnpm dev` |
| `pnpm db:migrate:local` / `pnpm db:migrate:remote` | Apply D1 migrations |
| `pnpm deploy` | `wrangler deploy` |

## Running a local league (Phase 1)

1. Export the Google Form responses as CSV with columns `name,defense_prompt,attack_prompt`
   and save it as `league/submissions.csv` (or copy the sample: `cp league/sample.csv league/submissions.csv`).
2. Run:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...   # never commit this
   pnpm league
   ```
   The runner validates every row (invalid rows are reported and skipped), prints the number of
   matches and the maximum possible cost, and asks for `y` before spending anything.
   Pass `--yes` to skip the prompt: `npx tsx scripts/run-league.ts league/submissions.csv --yes`.
3. Results go to `league/out/<timestamp>/`:
   - `standings.md` — Hebrew table (rank, name, Elo, W/D/L)
   - `matches/<A>_vs_<B>.md` — full transcripts with secrets; the crack moment is marked 🔓
   - `cost.json` — tokens and USD

## Worker backend (Phase 2)

### Local development

```bash
cp .dev.vars.example .dev.vars          # fill ANTHROPIC_API_KEY and GOOGLE_CLIENT_SECRET
# set GOOGLE_CLIENT_ID in wrangler.jsonc "vars" (test OAuth client, redirect URI below)
pnpm db:migrate:local
pnpm build && pnpm dev          # full app on http://localhost:8787
pnpm dev:web                    # optional, in a 2nd terminal: hot-reload UI on :5173
```

Google login always returns to `APP_URL` (8787), so test the login flow on :8787.

- Google OAuth redirect URI to register: `http://localhost:8787/api/auth/google/callback`
  (production: `{APP_URL}/api/auth/google/callback`).
- Trigger the cron locally (creates the season + bot versions, starts pending matches):
  `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*"`
  (the older `/__scheduled` path is swallowed by the SPA assets handler).
- Inspect local data: `npx wrangler d1 execute DB --local --command "SELECT * FROM matches"`
- Make a user admin: `npx wrangler d1 execute DB --local --command "UPDATE users SET is_admin = 1 WHERE email = 'you@example.com'"`
  (use `--remote` for production).

### One-time Cloudflare setup (production)

```bash
npx wrangler login
npx wrangler d1 create agent-wars            # put the printed database_id in wrangler.jsonc
npx wrangler queues create matches
npx wrangler queues create matches-dlq
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GOOGLE_CLIENT_SECRET
pnpm db:migrate:remote
```

Set `APP_URL` and `GOOGLE_CLIENT_ID` in `wrangler.jsonc` → `vars`.

### How matches run

Submitting a version creates up to 10 `pending` matches. The cron (every 15 min) starts up to
`MAX_ACTIVE_MATCHES` of them by sending `start_match` to the `matches` queue. Each queue message
then plays one turn of both channels (`step`) and enqueues the next one. Failed LLM calls are
retried by the queue; after 5 retries the message lands in `matches-dlq`, which marks the match
`error` and releases the credit hold.

## Deploy (Phase 4)

1. Do the one-time Cloudflare setup above (D1, queues, secrets, remote migrations) and set
   `APP_URL` to the production URL (e.g. `https://agent-wars.<you>.workers.dev`).
2. Google Cloud Console → OAuth client (Web): authorized redirect URI
   `{APP_URL}/api/auth/google/callback`. Put the client id in `GOOGLE_CLIENT_ID`.
3. Cloudflare dashboard → Workers & Pages → *Create* → *Import a repository* (Workers Builds),
   select this GitHub repo. Build command: `pnpm build`. Deploy command: `npx wrangler deploy`.
   Every push to the production branch deploys.
   (Manual alternative: `pnpm build && npx wrangler deploy`.)
4. Log in once on the site, then make yourself admin:
   `npx wrangler d1 execute DB --remote --command "UPDATE users SET is_admin = 1 WHERE email = 'you@example.com'"`
5. The first cron run (≤ 15 min) creates season 1 and the bots. To start it right away, use the
   dashboard's cron trigger test, or wait.
6. Smoke test: submit a version, wait for the cron, open a match replay.

### Free-plan capacity (checked against Cloudflare docs, Nov 2026)

- Queues: 10,000 operations/day; a message costs ~3; a match is 1 + up to 30 messages →
  roughly 100–300 matches/day (10–30 version submissions/day).
- D1: 100,000 rows written/day; a match writes ≤ ~500 rows.
- Workers: 100,000 requests/day, 10 ms CPU and 50 subrequests per invocation
  (a match step uses ≤ ~16 subrequests; waiting on the LLM does not count as CPU).
- Upgrade to Workers Paid when the queue limit becomes the bottleneck.

## Languages

The UI supports Hebrew (default, RTL) and English (LTR), switched with the 🌐 button in the header.
The choice is saved in the browser. All UI strings live in `src/web/strings.ts` (one dictionary per
language); API errors are translated on the client from their error `code`.

### Security notes

- API: same-origin + JSON-only POSTs (CSRF), HttpOnly/Secure/SameSite=Lax session cookie
  (only its SHA-256 is stored), 32 KB body limit, `no-store`, standard security headers.
- SPA: CSP and related headers in `src/web/public/_headers`.
- Prompts of other users and secrets of unfinished matches never leave the server
  (`src/worker/serializers.ts`, enforced by tests). Logs never contain prompts or secrets.

## Layout

```
src/engine/   pure game logic (no Cloudflare imports) — runs in Node and Workers
src/worker/   Cloudflare Worker: Hono API, queue consumer, cron, D1 access
src/web/      React 18 SPA (Vite, react-router, plain CSS); Hebrew (RTL, default) and English (LTR)
migrations/   D1 SQL migrations
data/         Hebrew noun list for secrets
scripts/      validate-words.ts, run-league.ts
league/       league input/output (only README.md and sample.csv are committed)
test/engine/  Vitest tests (Node)
test/worker/  Vitest tests in the Workers runtime (@cloudflare/vitest-plugin, local D1)
```

All tunables are in `src/engine/config.ts`.
