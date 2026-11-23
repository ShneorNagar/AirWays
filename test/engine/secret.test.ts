import { describe, expect, it } from "vitest";
import {
  WORDS,
  generateSecret,
  normalizeSecret,
  normalizeWord,
  randomIndex,
} from "../../src/engine/secret";
import { seq } from "./helpers";

describe("randomIndex (rejection sampling)", () => {
  it("rejects values at or above the largest multiple of n", () => {
    // 2^32 % 3 === 1, so the limit is 2^32 - 1: value 4294967295 must be rejected.
    const values = [4294967295, 7];
    let calls = 0;
    const src = () => values[calls++]!;
    expect(randomIndex(3, src)).toBe(7 % 3);
    expect(calls).toBe(2);
  });

  it("accepts the largest value below the limit", () => {
    expect(randomIndex(3, seq([4294967294]))).toBe(4294967294 % 3);
  });

  it("rejects the whole biased tail for a large n", () => {
    const n = 3_000_000_000; // limit = 3e9, so [3e9, 2^32) is rejected
    let calls = 0;
    const values = [3_000_000_000, 4294967295, 5];
    expect(randomIndex(n, () => values[calls++]!)).toBe(5);
    expect(calls).toBe(3);
  });

  it("never rejects when n is a power of two", () => {
    let calls = 0;
    expect(randomIndex(8, () => (calls++, 4294967295))).toBe(7);
    expect(calls).toBe(1);
  });

  it("produces a roughly uniform distribution with crypto randomness", () => {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 70000; i++) counts[randomIndex(7)]!++;
    for (const c of counts) expect(Math.abs(c - 10000)).toBeLessThan(600);
  });

  it("rejects invalid ranges", () => {
    expect(() => randomIndex(0)).toThrow();
    expect(() => randomIndex(1.5)).toThrow();
  });
});

describe("generateSecret", () => {
  it("returns two distinct words from the list joined by a hyphen", () => {
    for (let i = 0; i < 200; i++) {
      const s = generateSecret();
      const parts = s.split("-");
      expect(parts).toHaveLength(2);
      expect(parts[0]).not.toBe(parts[1]);
      expect(WORDS).toContain(parts[0]);
      expect(WORDS).toContain(parts[1]);
    }
  });

  it("redraws when the second index equals the first", () => {
    const words = ["אחד", "שתיים", "שלוש"];
    // indices: 0, then 0 again (redraw), then 2
    expect(generateSecret(words, seq([0, 0, 2]))).toBe("אחד-שלוש");
  });
});

describe("normalizeWord", () => {
  it("removes niqqud, maps finals, removes ו and י", () => {
    expect(normalizeWord("שָׁלוֹם")).toBe("שלמ");
    expect(normalizeWord("ארנב")).toBe("ארנב");
    expect(normalizeWord("עץ")).toBe("עצ");
    expect(normalizeWord("כיסוי")).toBe("כס");
  });
});

describe("normalizeSecret", () => {
  const target = "כחול-ארנב";
  it("matches the identical secret", () => {
    expect(normalizeSecret("כחול-ארנב")).toBe(normalizeSecret(target));
  });
  it("is order-insensitive", () => {
    expect(normalizeSecret("ארנב כחול")).toBe(normalizeSecret(target));
  });
  it("ignores niqqud", () => {
    expect(normalizeSecret("כָּחוֹל-אַרְנָב")).toBe(normalizeSecret(target));
  });
  it("ignores ו/י spelling variants", () => {
    expect(normalizeSecret("כחל-ארנב")).toBe(normalizeSecret(target));
    expect(normalizeSecret("עגבנייה-תפוח")).toBe(normalizeSecret("עגבניה-תפוח"));
  });
  it("treats final and regular letter forms as equal", () => {
    expect(normalizeSecret("עץ-גן")).toBe(normalizeSecret("עצ-גנ"));
  });
  it("accepts any separator", () => {
    for (const s of ["כחול ארנב", "כחול,ארנב", "  כחול – ארנב.", "\"כחול\" / \"ארנב\"", "כחול_ארנב"]) {
      expect(normalizeSecret(s)).toBe(normalizeSecret(target));
    }
  });
  it("treats non-Hebrew characters as separators", () => {
    expect(normalizeSecret("secret: כחול ארנב")).toBe(normalizeSecret(target));
  });
  it("returns null for the wrong number of words", () => {
    expect(normalizeSecret("כחול")).toBeNull();
    expect(normalizeSecret("כחול ארנב גדול")).toBeNull();
    expect(normalizeSecret("")).toBeNull();
    expect(normalizeSecret("blue rabbit")).toBeNull();
  });
  it("does not match different words", () => {
    expect(normalizeSecret("כחול-חתול")).not.toBe(normalizeSecret(target));
  });
});
