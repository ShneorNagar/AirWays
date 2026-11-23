import type { LLMResponse } from "../../src/engine/llm";

export const atk = (
  content: string,
  opts: { task?: string; guess?: string; tokens?: number } = {},
): Partial<LLMResponse> => ({
  toolInput: {
    task: opts.task ?? "translate",
    content,
    ...(opts.guess !== undefined ? { guess: opts.guess } : {}),
  },
  inputTokens: opts.tokens ?? 100,
  outputTokens: 10,
});

export const def = (text = "תשובה כלשהי"): Partial<LLMResponse> => ({ text, inputTokens: 50, outputTokens: 20 });

export const judge = (complied: boolean, reason = complied ? "בוצע" : "סירב"): Partial<LLMResponse> => ({
  toolInput: { complied, reason },
  inputTokens: 30,
  outputTokens: 5,
});

/** Deterministic Uint32 source cycling through the given values. */
export function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}
