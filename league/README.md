# league/

Input and output folder for the Phase-1 local league runner (`pnpm league`).

- `submissions.csv` — your Google Forms export (gitignored). Columns: `name,defense_prompt,attack_prompt`.
- `sample.csv` — a 3-player sample, committed.
- `out/<timestamp>/` — results (gitignored): `standings.md`, `matches/*.md`, `cost.json`.

Run the sample: `ANTHROPIC_API_KEY=... npx tsx scripts/run-league.ts league/sample.csv`
