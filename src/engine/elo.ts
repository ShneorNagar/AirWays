import { ELO_K } from "./config";
import type { MatchResult } from "./types";

const round1 = (x: number) => Math.round(x * 10) / 10;

export function expectedScore(ra: number, rb: number): number {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

/** Spec 5.7. Returns new ratings rounded to 1 decimal. */
export function updateElo(ra: number, rb: number, result: MatchResult): { a: number; b: number } {
  const sa = result === "a" ? 1 : result === "draw" ? 0.5 : 0;
  const sb = 1 - sa;
  const ea = expectedScore(ra, rb);
  const eb = expectedScore(rb, ra);
  return { a: round1(ra + ELO_K * (sa - ea)), b: round1(rb + ELO_K * (sb - eb)) };
}
