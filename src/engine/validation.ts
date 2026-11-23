import { PROMPT_MAX_CHARS, PROMPT_MIN_CHARS } from "./config";

export type PromptField = "defense_prompt" | "attack_prompt";
export type ValidationErrorCode = "too_short" | "too_long" | "forbidden_tag";
export type ValidationResult =
  | { ok: true }
  | { ok: false; field: PromptField; error_code: ValidationErrorCode };

export const FORBIDDEN_SUBSTRINGS = [
  "player_instructions",
  "<request",
  "</request",
  "<game_state",
  "<transcript",
];

export function validatePrompt(text: string): ValidationErrorCode | null {
  const s = text.trim();
  if (s.length < PROMPT_MIN_CHARS) return "too_short";
  if (s.length > PROMPT_MAX_CHARS) return "too_long";
  const lower = s.toLowerCase();
  if (FORBIDDEN_SUBSTRINGS.some((f) => lower.includes(f))) return "forbidden_tag";
  return null;
}

export function validateVersion(v: { defense_prompt: unknown; attack_prompt: unknown }): ValidationResult {
  for (const field of ["defense_prompt", "attack_prompt"] as const) {
    const value = v[field];
    const code = validatePrompt(typeof value === "string" ? value : "");
    if (code) return { ok: false, field, error_code: code };
  }
  return { ok: true };
}
