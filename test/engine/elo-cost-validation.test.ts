import { describe, expect, it } from "vitest";
import { CONTENT_MAX_CHARS, PROMPT_MAX_CHARS } from "../../src/engine/config";
import {
  assertPricesConfigured,
  callCostUsdMicro,
  computeChargeCredits,
  computeHoldCredits,
  computeMaxMatchUsdMicro,
} from "../../src/engine/cost";
import { expectedScore, updateElo } from "../../src/engine/elo";
import { validatePrompt, validateVersion } from "../../src/engine/validation";

describe("elo", () => {
  it("equal ratings, A wins", () => {
    expect(updateElo(1000, 1000, "a")).toEqual({ a: 1016, b: 984 });
  });
  it("equal ratings, draw", () => {
    expect(updateElo(1000, 1000, "draw")).toEqual({ a: 1000, b: 1000 });
  });
  it("200-point gap, underdog wins", () => {
    // E_a = 1/(1+10^(200/400)) = 0.2402530734; 32*(1-0.2402530734) = 24.3119
    expect(expectedScore(1000, 1200)).toBeCloseTo(0.2402530734, 9);
    expect(updateElo(1000, 1200, "a")).toEqual({ a: 1024.3, b: 1175.7 });
  });
  it("200-point gap, favourite wins; draw shifts toward the underdog", () => {
    expect(updateElo(1200, 1000, "a")).toEqual({ a: 1207.7, b: 992.3 });
    expect(updateElo(1000, 1200, "draw")).toEqual({ a: 1008.3, b: 1191.7 });
  });
  it("B wins", () => {
    expect(updateElo(1000, 1000, "b")).toEqual({ a: 984, b: 1016 });
  });
});

describe("cost", () => {
  const fixed = { "claude-haiku-5-5": { input: 1, output: 5 } };
  it("callCostUsdMicro: input 1, output 5, 1000 in + 200 out => 2000 micro-USD", () => {
    expect(callCostUsdMicro("claude-haiku-5-5", 1000, 200, fixed)).toBe(2000);
  });
  it("throws for unknown or NaN prices", () => {
    expect(() => callCostUsdMicro("nope", 1, 1, fixed)).toThrow();
    expect(() => callCostUsdMicro("claude-haiku-5-5", 1, 1, { "claude-haiku-5-5": { input: NaN, output: 1 } })).toThrow();
    expect(() => assertPricesConfigured({ "claude-haiku-5-5": { input: NaN, output: NaN } })).toThrow(/not configured/);
  });
  it("configured prices pass", () => {
    expect(() => assertPricesConfigured()).not.toThrow();
  });
  it("hold with fixed prices (input 1, output 5)", () => {
    // player call: 12000*1 + 500*5 = 14500; judge: 4000*1 + 200*5 = 5000
    // per turn = 2*14500 + 5000 = 34000 micro; max = 3*2*10*34000 = 2,040,000 micro = $2.04
    expect(computeMaxMatchUsdMicro(fixed)).toBe(2_040_000);
    // credits = ceil(2.04 * 1.2 / 0.01) = ceil(244.8) = 245
    expect(computeHoldCredits(fixed)).toBe(245);
  });
  it("hold with the configured haiku-5-5 prices", () => {
    // player: 12000*0.1 + 500*0.5 = 1450; judge: 400 + 100 = 500; per turn 3400; max 204000 micro
    expect(computeMaxMatchUsdMicro()).toBe(204_000);
    expect(computeHoldCredits()).toBe(25); // ceil(24.48)
  });
  it("charge = ceil(actual * 1.2 / 0.01)", () => {
    expect(computeChargeCredits(0)).toBe(0);
    expect(computeChargeCredits(2000)).toBe(1); // 0.24 credits -> 1
    expect(computeChargeCredits(100_000)).toBe(12); // $0.10 * 1.2 = 12 credits exactly
    expect(computeChargeCredits(100_001)).toBe(13);
    expect(computeChargeCredits(250_000)).toBe(30); // exact, no float overshoot
  });
});

describe("validation", () => {
  const ok = "x".repeat(50);
  it("accepts valid prompts", () => {
    expect(validateVersion({ defense_prompt: ok, attack_prompt: ok })).toEqual({ ok: true });
  });
  it("too_short after trim", () => {
    expect(validatePrompt("   short   ")).toBe("too_short");
    expect(validateVersion({ defense_prompt: "short", attack_prompt: ok })).toEqual({ ok: false, field: "defense_prompt", error_code: "too_short" });
  });
  it("boundaries", () => {
    expect(validatePrompt("x".repeat(20))).toBeNull();
    expect(validatePrompt("x".repeat(19))).toBe("too_short");
    expect(validatePrompt("x".repeat(PROMPT_MAX_CHARS))).toBeNull();
    expect(validatePrompt("  " + "x".repeat(PROMPT_MAX_CHARS) + "  ")).toBeNull();
  });
  it("too_long", () => {
    expect(validateVersion({ defense_prompt: ok, attack_prompt: "x".repeat(PROMPT_MAX_CHARS + 1) })).toEqual({ ok: false, field: "attack_prompt", error_code: "too_long" });
  });
  it("forbidden tags, case-insensitive", () => {
    for (const bad of ["PLAYER_INSTRUCTIONS", "<request>", "</Request>", "<GAME_STATE", "<transcript"]) {
      expect(validatePrompt(`${ok} ${bad} ${ok}`)).toBe("forbidden_tag");
    }
  });
  it("non-string input is too_short", () => {
    expect(validateVersion({ defense_prompt: undefined, attack_prompt: ok })).toMatchObject({ ok: false, error_code: "too_short" });
  });
  it("CONTENT_MAX_CHARS is defined", () => {
    expect(CONTENT_MAX_CHARS).toBe(1500);
  });
});
