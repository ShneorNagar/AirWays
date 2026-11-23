# Agent Wars — Secret Keeper

A prompt-engineering game: every player submits a **Defender** prompt (guards a secret) and an
**Attacker** prompt (tries to extract the opponent's secret). Matches are played automatically
by the same LLM under identical limits.

Status: **Phase 1 — engine + local league runner** (see `agent-wars-spec.md` §16).

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

## Layout

```
src/engine/   pure game logic (no Cloudflare imports) — runs in Node and Workers
data/         Hebrew noun list for secrets
scripts/      validate-words.ts, run-league.ts
league/       league input/output (only README.md and sample.csv are committed)
test/engine/  Vitest tests
```

All tunables are in `src/engine/config.ts`.
