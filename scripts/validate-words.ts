// Validates data/words.he.json against spec 5.2. Exit code 1 on failure.
import { readFileSync } from "node:fs";
import { normalizeWord } from "../src/engine/secret";

export const MIN_WORDS = 2000;
const WORD_RE = /^[א-ת]{2,8}$/;

export function validateWords(words: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(words)) return ["file must contain a JSON array"];
  if (words.length < MIN_WORDS) errors.push(`need >= ${MIN_WORDS} words, found ${words.length}`);
  const seen = new Map<string, string>();
  words.forEach((w, i) => {
    if (typeof w !== "string") {
      errors.push(`#${i}: not a string`);
      return;
    }
    if (w !== w.normalize("NFC")) errors.push(`#${i} "${w}": not NFC`);
    if (!WORD_RE.test(w)) errors.push(`#${i} "${w}": must be 2-8 Hebrew letters (א-ת), no niqqud/spaces/punctuation`);
    const key = normalizeWord(w);
    if (key.length === 0) errors.push(`#${i} "${w}": empty after normalization`);
    const prev = seen.get(key);
    if (prev !== undefined) errors.push(`#${i} "${w}": collides with "${prev}" after normalizeWord ("${key}")`);
    else seen.set(key, w);
  });
  return errors;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const path = new URL("../data/words.he.json", import.meta.url);
  const words = JSON.parse(readFileSync(path, "utf8"));
  const errors = validateWords(words);
  if (errors.length) {
    console.error(errors.slice(0, 100).join("\n"));
    console.error(`\n✗ ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log(`✓ words.he.json OK (${words.length} words)`);
}
