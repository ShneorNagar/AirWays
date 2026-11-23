import wordsJson from "../../data/words.he.json";

export const WORDS: readonly string[] = wordsJson as string[];

const NIQQUD_RE = /[֑-ׇ]/g;
const NON_HEBREW_LETTER_RE = /[^א-ת]/g;
const FINALS: Record<string, string> = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };

export function normalizeWord(w: string): string {
  return w
    .replace(NIQQUD_RE, "")
    .replace(/[ךםןףץ]/g, (c) => FINALS[c]!)
    .replace(/[וי]/g, "");
}

/** Returns a canonical, order-insensitive key, or null if the text is not exactly two words. */
export function normalizeSecret(s: string): string | null {
  const words = s
    .normalize("NFC")
    .replace(NIQQUD_RE, "")
    .replace(NON_HEBREW_LETTER_RE, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length !== 2) return null;
  return words.map(normalizeWord).sort().join("|");
}

export function secretsMatch(guess: string, target: string): boolean {
  const g = normalizeSecret(guess);
  return g !== null && g === normalizeSecret(target);
}

export type Uint32Source = () => number;

export const cryptoUint32: Uint32Source = () => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!;
};

const TWO_POW_32 = 2 ** 32;

/** Uniform index in [0, n) using rejection sampling (no modulo bias). */
export function randomIndex(n: number, next: Uint32Source = cryptoUint32): number {
  if (!Number.isInteger(n) || n <= 0 || n > TWO_POW_32) throw new Error(`invalid range ${n}`);
  // Largest multiple of n that fits in 2^32; values >= limit are rejected.
  const limit = TWO_POW_32 - (TWO_POW_32 % n);
  for (;;) {
    const x = next();
    if (x < limit) return x % n;
  }
}

/** Two distinct words joined by "-". */
export function generateSecret(words: readonly string[] = WORDS, next: Uint32Source = cryptoUint32): string {
  if (words.length < 2) throw new Error("word list too small");
  const i = randomIndex(words.length, next);
  let j = randomIndex(words.length, next);
  while (j === i) j = randomIndex(words.length, next);
  return `${words[i]}-${words[j]}`;
}
