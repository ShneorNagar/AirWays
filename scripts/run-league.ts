// Phase-1 local league runner (spec 13).
// Usage: pnpm league            (reads league/submissions.csv)
//        tsx scripts/run-league.ts <file.csv> [--yes]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse } from "csv-parse/sync";
import { ELO_START, LEAGUE_CONCURRENCY } from "../src/engine/config";
import { callCostUsdMicro, computeMaxMatchUsdMicro } from "../src/engine/cost";
import { updateElo } from "../src/engine/elo";
import { AnthropicClient, type LLMClient, type UsageEvent } from "../src/engine/llm";
import { runFullMatch, type FullMatchResult, type RoundResult } from "../src/engine/runner";
import type { Side, Task, VersionPrompts } from "../src/engine/types";
import { validateVersion, type ValidationResult } from "../src/engine/validation";

export interface Entry extends VersionPrompts {
  name: string;
}

export interface InvalidRow {
  row: number; // 1-based data row (header excluded)
  name: string;
  reason: string;
}

export function parseSubmissions(csvText: string): { entries: Entry[]; invalid: InvalidRow[] } {
  const records = parse(csvText, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
  }) as Record<string, string | undefined>[];

  const entries: Entry[] = [];
  const invalid: InvalidRow[] = [];
  const usedNames = new Set<string>();
  records.forEach((rec, i) => {
    const name = (rec.name ?? "").trim();
    const defense_prompt = (rec.defense_prompt ?? "").trim();
    const attack_prompt = (rec.attack_prompt ?? "").trim();
    if (!name) {
      invalid.push({ row: i + 1, name: "", reason: "missing name" });
      return;
    }
    const v: ValidationResult = validateVersion({ defense_prompt, attack_prompt });
    if (!v.ok) {
      invalid.push({ row: i + 1, name, reason: `${v.field}: ${v.error_code}` });
      return;
    }
    let unique = name;
    for (let n = 2; usedNames.has(unique); n++) unique = `${name} (${n})`;
    usedNames.add(unique);
    entries.push({ name: unique, defense_prompt, attack_prompt });
  });
  return { entries, invalid };
}

/** Every pair once, in a deterministic order (this is also the Elo "play order"). */
export function roundRobin<T>(items: T[]): [T, T][] {
  const pairs: [T, T][] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) pairs.push([items[i]!, items[j]!]);
  return pairs;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface PlayedMatch {
  a: Entry;
  b: Entry;
  result: FullMatchResult | null;
  error: string | null;
}

export interface Standing {
  name: string;
  elo: number;
  wins: number;
  draws: number;
  losses: number;
}

export function computeStandings(entries: Entry[], played: PlayedMatch[]): Standing[] {
  const table = new Map<string, Standing>(
    entries.map((e) => [e.name, { name: e.name, elo: ELO_START, wins: 0, draws: 0, losses: 0 }]),
  );
  for (const m of played) {
    if (!m.result) continue;
    const sa = table.get(m.a.name)!;
    const sb = table.get(m.b.name)!;
    const next = updateElo(sa.elo, sb.elo, m.result.result);
    sa.elo = next.a;
    sb.elo = next.b;
    if (m.result.result === "draw") {
      sa.draws++;
      sb.draws++;
    } else if (m.result.result === "a") {
      sa.wins++;
      sb.losses++;
    } else {
      sb.wins++;
      sa.losses++;
    }
  }
  return [...table.values()].sort((x, y) => y.elo - x.elo || x.name.localeCompare(y.name));
}

const mdCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderStandings(standings: Standing[], played: PlayedMatch[]): string {
  const lines = [
    "# טבלת הליגה",
    "",
    "| מקום | שם | Elo | נ/ת/ה |",
    "|---|---|---|---|",
    ...standings.map(
      (s, i) => `| ${i + 1} | ${mdCell(s.name)} | ${s.elo.toFixed(1)} | ${s.wins}/${s.draws}/${s.losses} |`,
    ),
    "",
    "נ = ניצחונות, ת = תיקו, ה = הפסדים. דירוג Elo מתחיל ב-1000.",
  ];
  const failed = played.filter((m) => m.error);
  if (failed.length) {
    lines.push("", "## קרבות שנכשלו", "", ...failed.map((m) => `- ${m.a.name} נגד ${m.b.name}`));
  }
  return lines.join("\n") + "\n";
}

const TASK_HE: Record<Task, string> = { translate: "תרגם", summarize: "סכם", answer: "ענה" };
const END_REASON_HE: Record<RoundResult["end_reason"], string> = {
  cracked: "הסוד נפרץ",
  forfeit: "המגן נפסל (3 פסילות)",
  tiebreak_guesses: "שבירת שוויון: פחות ניחושים",
  tiebreak_tokens: "שבירת שוויון: פחות טוקנים",
  draw_exhausted: "תיקו: נגמרו התורות",
  draw_tie: "תיקו מוחלט",
};
const CHANNEL_STATUS_HE: Record<string, string> = {
  open: "פתוח",
  cracked: "נפרץ 🔓",
  forfeit: "המגן נפסל",
  exhausted: "נגמרו התורות",
  stopped: "נעצר",
};

const quote = (s: string) => (s === "" ? "> _(ריק)_" : s.split("\n").map((l) => `> ${l}`).join("\n"));

export function renderMatch(m: PlayedMatch): string {
  const names: Record<Side, string> = { a: m.a.name, b: m.b.name };
  const out: string[] = [`# ${names.a} נגד ${names.b}`, ""];
  if (!m.result) {
    out.push(`הקרב נכשל: ${m.error ?? "שגיאה לא ידועה"}`);
    return out.join("\n") + "\n";
  }
  const r = m.result;
  const winnerText =
    r.result === "draw" ? "תיקו" : `המנצח: **${names[r.result]}**`;
  out.push(`**תוצאה:** ${names.a} ${r.rounds_a} – ${r.rounds_b} ${names.b} · ${winnerText}`, "");

  for (const round of r.rounds) {
    const roundWinner = round.winner === "draw" ? "תיקו" : names[round.winner];
    out.push(
      `## סיבוב ${round.round_no}`,
      "",
      `- הסוד של ${names.a}: **${round.secret_a}**`,
      `- הסוד של ${names.b}: **${round.secret_b}**`,
      `- מנצח הסיבוב: **${roundWinner}** (${END_REASON_HE[round.end_reason]}, תור ${round.end_turn})`,
      "",
    );
    for (const side of ["a", "b"] as const) {
      const other: Side = side === "a" ? "b" : "a";
      const ch = round.channels[side];
      const target = side === "a" ? round.secret_b : round.secret_a;
      out.push(
        `### התוקף של ${names[side]} ← המגן של ${names[other]} (יעד: ${target})`,
        "",
        `סטטוס: ${CHANNEL_STATUS_HE[ch.status]} · ניחושים: ${ch.guesses_used} · פסילות: ${ch.strikes}`,
        "",
      );
      for (const t of ch.turns) {
        const cracked = t.guess_correct === true;
        out.push(`#### ${cracked ? "🔓 " : ""}תור ${t.turn_no} · ${TASK_HE[t.attacker_task]}`, "", "**תוכן:**", "", quote(t.attacker_content), "");
        if (t.guess !== null) {
          const mark = t.guess_correct === true ? "✅" : t.guess_correct === false ? "❌" : "⛔ (לא נותרו ניחושים)";
          out.push(`**ניחוש:** ${t.guess} ${mark}`, "");
        }
        if (cracked) {
          out.push("🔓 **הסוד נפרץ!**", "");
          continue;
        }
        out.push("**תשובת המגן:**", "", quote(t.defender_reply ?? ""), "");
        out.push(
          t.verdict_complied ? `**שופט:** ✔ ביצע` : `**שופט:** ⚠ פסילה — ${t.verdict_reason ?? ""}`,
          "",
        );
      }
    }
  }
  return out.join("\n") + "\n";
}

export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "player";
}

export interface CostTracker {
  onUsage: (u: UsageEvent) => void;
  summary: () => {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    usd: number;
    by_role: Record<string, { calls: number; input_tokens: number; output_tokens: number; usd: number }>;
  };
}

export function createCostTracker(): CostTracker {
  let calls = 0, input = 0, output = 0, micro = 0;
  const byRole: Record<string, { calls: number; input_tokens: number; output_tokens: number; micro: number }> = {};
  return {
    onUsage(u) {
      const c = callCostUsdMicro(u.model, u.inputTokens, u.outputTokens);
      calls++;
      input += u.inputTokens;
      output += u.outputTokens;
      micro += c;
      const r = (byRole[u.role] ??= { calls: 0, input_tokens: 0, output_tokens: 0, micro: 0 });
      r.calls++;
      r.input_tokens += u.inputTokens;
      r.output_tokens += u.outputTokens;
      r.micro += c;
    },
    summary() {
      return {
        calls,
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
        usd: micro / 1e6,
        by_role: Object.fromEntries(
          Object.entries(byRole).map(([k, v]) => [
            k,
            { calls: v.calls, input_tokens: v.input_tokens, output_tokens: v.output_tokens, usd: v.micro / 1e6 },
          ]),
        ),
      };
    },
  };
}

export async function runLeague(
  entries: Entry[],
  llm: LLMClient,
  log: (msg: string) => void = () => {},
): Promise<PlayedMatch[]> {
  const pairs = roundRobin(entries);
  return mapWithConcurrency(pairs, LEAGUE_CONCURRENCY, async ([a, b], i) => {
    log(`▶ (${i + 1}/${pairs.length}) ${a.name} נגד ${b.name}`);
    try {
      const result = await runFullMatch({ llm, a, b });
      log(`✔ (${i + 1}/${pairs.length}) ${a.name} ${result.rounds_a}–${result.rounds_b} ${b.name}`);
      return { a, b, result, error: null };
    } catch (err) {
      const msg = (err as Error).message;
      log(`✗ (${i + 1}/${pairs.length}) ${a.name} נגד ${b.name}: ${msg}`);
      return { a, b, result: null, error: msg };
    }
  });
}

export function writeOutputs(
  outDir: string,
  entries: Entry[],
  played: PlayedMatch[],
  cost: ReturnType<CostTracker["summary"]>,
): void {
  mkdirSync(join(outDir, "matches"), { recursive: true });
  writeFileSync(join(outDir, "standings.md"), renderStandings(computeStandings(entries, played), played));
  const usedFiles = new Set<string>();
  for (const m of played) {
    let base = `${safeFileName(m.a.name)}_vs_${safeFileName(m.b.name)}`;
    for (let n = 2; usedFiles.has(base); n++) base = `${safeFileName(m.a.name)}_vs_${safeFileName(m.b.name)}_${n}`;
    usedFiles.add(base);
    writeFileSync(join(outDir, "matches", `${base}.md`), renderMatch(m));
  }
  writeFileSync(join(outDir, "cost.json"), JSON.stringify(cost, null, 2) + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith("--"));
  const autoYes = args.includes("--yes");
  if (!csvPath) {
    console.error("usage: tsx scripts/run-league.ts <submissions.csv> [--yes]");
    process.exit(2);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exit(2);
  }

  const { entries, invalid } = parseSubmissions(readFileSync(csvPath, "utf8"));
  for (const r of invalid) console.warn(`⚠ skipped row ${r.row} (${r.name || "no name"}): ${r.reason}`);
  if (entries.length < 2) {
    console.error("need at least 2 valid submissions");
    process.exit(1);
  }

  const matchCount = (entries.length * (entries.length - 1)) / 2;
  const maxUsd = (matchCount * computeMaxMatchUsdMicro()) / 1e6;
  console.log(`${entries.length} players, ${matchCount} matches. Max possible cost (hold-based): $${maxUsd.toFixed(2)}`);
  if (!autoYes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Continue? (y/N) ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y") {
      console.log("aborted");
      return;
    }
  }

  const tracker = createCostTracker();
  const llm = new AnthropicClient({ apiKey, onUsage: tracker.onUsage });
  const played = await runLeague(entries, llm, (m) => console.log(m));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join("league", "out", stamp);
  const cost = tracker.summary();
  writeOutputs(outDir, entries, played, cost);
  console.log(`\nOutputs: ${outDir}`);
  console.log(`Total cost: $${cost.usd.toFixed(4)} (${cost.total_tokens} tokens, ${cost.calls} calls)`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
