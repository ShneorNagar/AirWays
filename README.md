# Agent Wars — Secret Keeper

A prompt-engineering game: every player submits a **Defender** prompt (guards a secret) and an
**Attacker** prompt (tries to extract the opponent's secret). Matches are played automatically
by the same LLM under identical limits.

Status: **Phase 2 — Worker backend** done (Phase 1: engine + local league runner). See `agent-wars-spec.md` §16.

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
| `pnpm dev` | `wrangler dev` with local D1 + local queues (http://localhost:8787) |
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
pnpm dev
```

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

## Layout

```
src/engine/   pure game logic (no Cloudflare imports) — runs in Node and Workers
src/worker/   Cloudflare Worker: Hono API, queue consumer, cron, D1 access
migrations/   D1 SQL migrations
data/         Hebrew noun list for secrets
scripts/      validate-words.ts, run-league.ts
league/       league input/output (only README.md and sample.csv are committed)
test/engine/  Vitest tests (Node)
test/worker/  Vitest tests in the Workers runtime (@cloudflare/vitest-plugin, local D1)
```

All tunables are in `src/engine/config.ts`.
