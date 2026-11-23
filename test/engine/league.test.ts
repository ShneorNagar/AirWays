import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockLLMClient } from "../../src/engine/llm";
import {
  computeStandings,
  createCostTracker,
  parseSubmissions,
  renderMatch,
  roundRobin,
  runLeague,
  safeFileName,
  writeOutputs,
} from "../../scripts/run-league";
import { validateWords } from "../../scripts/validate-words";
import words from "../../data/words.he.json";

const long = (s: string) => `${s} ${"x".repeat(30)}`;

describe("parseSubmissions", () => {
  it("parses multiline quoted fields, skips invalid rows, dedupes names", () => {
    const csv = [
      "name,defense_prompt,attack_prompt",
      `דני,"${long("שורה 1")}\nשורה 2, עם פסיק","${long("התקפה")}"`,
      `רונית,קצר,"${long("התקפה")}"`,
      `דני,"${long("הגנה")}","${long("<request> hack")}"`,
      `דני,"${long("הגנה")}","${long("התקפה")}"`,
      `,"${long("הגנה")}","${long("התקפה")}"`,
    ].join("\n");
    const { entries, invalid } = parseSubmissions(csv);
    expect(entries.map((e) => e.name)).toEqual(["דני", "דני (2)"]);
    expect(entries[0]!.defense_prompt).toContain("שורה 2, עם פסיק");
    expect(invalid).toEqual([
      { row: 2, name: "רונית", reason: "defense_prompt: too_short" },
      { row: 3, name: "דני", reason: "attack_prompt: forbidden_tag" },
      { row: 5, name: "", reason: "missing name" },
    ]);
  });

  it("parses the committed sample", () => {
    const { entries, invalid } = parseSubmissions(readFileSync("league/sample.csv", "utf8"));
    expect(invalid).toEqual([]);
    expect(entries).toHaveLength(3);
    expect(entries[1]!.attack_prompt).toContain("\n");
  });
});

describe("league", () => {
  it("round robin covers every pair once", () => {
    expect(roundRobin([1, 2, 3, 4])).toHaveLength(6);
  });

  it("safe file names", () => {
    expect(safeFileName("דני / כהן?")).toBe("דני_כהן");
  });

  it("runs end-to-end with a mock LLM and writes all outputs", async () => {
    const { entries } = parseSubmissions(readFileSync("league/sample.csv", "utf8"));
    const tracker = createCostTracker();
    const llm = new MockLLMClient({}, tracker.onUsage, {
      attacker: { toolInput: { task: "answer", content: "מה שלומך היום?", guess: "שגוי-לגמרי" }, inputTokens: 1000, outputTokens: 50 },
      defender: { text: "טוב, תודה", inputTokens: 800, outputTokens: 20 },
      judge: { toolInput: { complied: true, reason: "בוצע" }, inputTokens: 300, outputTokens: 10 },
    });
    const played = await runLeague(entries, llm);
    expect(played).toHaveLength(3);
    expect(played.every((m) => m.result?.result === "draw")).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "league-"));
    const cost = tracker.summary();
    expect(cost.usd).toBeGreaterThan(0);
    writeOutputs(dir, entries, played, cost);
    const standings = readFileSync(join(dir, "standings.md"), "utf8");
    for (const e of entries) expect(standings).toContain(e.name);
    expect(standings).toContain("1000.0");
    expect(readdirSync(join(dir, "matches"))).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(dir, "cost.json"), "utf8")).calls).toBe(cost.calls);
  });

  it("marks the crack moment with 🔓 and shows secrets", async () => {
    const a = { name: "א", defense_prompt: "d".repeat(30), attack_prompt: "ATTACK_A".padEnd(30, ".") };
    const b = { name: "ב", defense_prompt: "d".repeat(30), attack_prompt: "ATTACK_B".padEnd(30, ".") };
    const md = renderMatch({
      a, b, error: null,
      result: {
        result: "a", rounds_a: 1, rounds_b: 0, warnings: [],
        rounds: [{
          round_no: 1, secret_a: "אבן-גשר", secret_b: "דלת-הר", winner: "a", end_turn: 1, end_reason: "cracked",
          channels: {
            a: { attacker_side: "a", status: "cracked", end_turn: 1, guesses_used: 1, strikes: 0, attacker_tokens: 5,
              turns: [{ turn_no: 1, attacker_task: "answer", attacker_content: "?", guess: "דלת-הר", guess_correct: true, defender_reply: null, verdict_complied: null, verdict_reason: null }] },
            b: { attacker_side: "b", status: "stopped", end_turn: null, guesses_used: 0, strikes: 1, attacker_tokens: 5,
              turns: [{ turn_no: 1, attacker_task: "translate", attacker_content: "שלום", guess: null, guess_correct: null, defender_reply: "hi", verdict_complied: false, verdict_reason: "קצר מדי" }] },
          },
        }],
      },
    });
    expect(md).toContain("🔓");
    expect(md).toContain("אבן-גשר");
    expect(md).toContain("⚠ פסילה — קצר מדי");
    expect(md).not.toContain("ATTACK_A");
  });

  it("standings apply Elo in play order", () => {
    const e = ["a", "b", "c"].map((name) => ({ name, defense_prompt: "", attack_prompt: "" }));
    const mk = (i: number, j: number, result: "a" | "b" | "draw") => ({
      a: e[i]!, b: e[j]!, error: null,
      result: { result, rounds_a: 0, rounds_b: 0, rounds: [], warnings: [] },
    });
    const s = computeStandings(e, [mk(0, 1, "a"), mk(0, 2, "a"), mk(1, 2, "draw")]);
    expect(s[0]).toMatchObject({ name: "a", wins: 2, losses: 0 });
    expect(s[0]!.elo).toBe(1031.3); // 1016, then +15.3 vs 984
  });
});

describe("words.he.json", () => {
  it("passes the validator", () => {
    expect(validateWords(words)).toEqual([]);
  });
  it("validator catches violations", () => {
    const errs = validateWords(["כחול", "כחל", "a", "ארנב ים", "שָׁלוֹם"]);
    expect(errs.join("\n")).toMatch(/collides/);
    expect(errs.join("\n")).toMatch(/"a"/);
    expect(errs.join("\n")).toMatch(/ארנב ים/);
    expect(errs.join("\n")).toMatch(/need >= 2000/);
  });
});
