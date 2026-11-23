import {
  ATTACKER_MAX_TOKENS,
  CONTENT_MAX_CHARS,
  CONTENT_MIN_CHARS_FOR_JUDGE,
  DEFENDER_MAX_TOKENS,
  DISABLE_THINKING,
  JUDGE_MAX_TOKENS,
  JUDGE_MODEL,
  JUDGE_REASON_MAX_CHARS,
  JUDGE_TEMPERATURE,
  MAX_GUESSES,
  MAX_STRIKES,
  MAX_TURNS,
  PLAYER_MODEL,
  PLAYER_TEMPERATURE,
} from "./config";
import type { LLMClient } from "./llm";
import {
  JUDGE_SYSTEM_PROMPT,
  TAKE_TURN_TOOL,
  VERDICT_TOOL,
  attackerSystemPrompt,
  attackerUserMessage,
  defenderMessages,
  defenderSystemPrompt,
  judgeUserMessage,
} from "./prompts";
import { secretsMatch } from "./secret";
import { TASKS, type ChannelState, type Task, type TurnRecord } from "./types";

export interface AttackerMove {
  task: Task;
  content: string;
  guess: string | undefined;
}

/** Spec 5.3.1: invalid tool output => {answer, "", no guess}; bad task => "answer"; truncate content. */
export function parseAttackerMove(toolInput: Record<string, unknown> | null): AttackerMove {
  const fallback: AttackerMove = { task: "answer", content: "", guess: undefined };
  if (!toolInput) return fallback;
  const { task, content, guess } = toolInput;
  if (typeof content !== "string") return fallback;
  if (guess !== undefined && guess !== null && typeof guess !== "string") return fallback;
  const validTask = typeof task === "string" && (TASKS as readonly string[]).includes(task);
  return {
    task: validTask ? (task as Task) : "answer",
    content: content.slice(0, CONTENT_MAX_CHARS),
    guess: typeof guess === "string" ? guess : undefined,
  };
}

export interface ChannelTurnInput {
  llm: LLMClient;
  turnNo: number;
  /** The secret held by this channel's defender (= the attacker's target). */
  secret: string;
  attackPrompt: string;
  defensePrompt: string;
  state: ChannelState;
  /** Previous turns of this channel in this round, in order. */
  history: TurnRecord[];
}

export interface ChannelTurnResult {
  turn: TurnRecord;
  state: ChannelState;
  /** Warnings worth logging (never contains secrets or prompts). */
  warnings: string[];
}

/**
 * Runs ONE turn of ONE channel (spec 5.3). Pure with respect to its inputs: returns the
 * new turn and new channel state; persisting them is the caller's job. LLM errors
 * (after in-call retries) propagate so the caller can retry the whole channel-turn.
 */
export async function runChannelTurn(input: ChannelTurnInput): Promise<ChannelTurnResult> {
  const { llm, turnNo: t, secret, history } = input;
  if (input.state.status !== "open") throw new Error(`channel not open: ${input.state.status}`);
  const state: ChannelState = { ...input.state };
  const warnings: string[] = [];

  // 1. Attacker
  const previousGuesses = history
    .filter((h) => h.guess !== null && h.guess_correct !== null)
    .map((h) => h.guess as string);
  const atk = await llm.call(
    {
      model: PLAYER_MODEL,
      system: attackerSystemPrompt(input.attackPrompt),
      messages: [
        {
          role: "user",
          content: attackerUserMessage({
            turnNo: t,
            guessesUsed: state.guesses_used,
            previousGuesses,
            strikes: state.strikes,
            history,
          }),
        },
      ],
      max_tokens: ATTACKER_MAX_TOKENS,
      temperature: PLAYER_TEMPERATURE,
      disable_thinking: DISABLE_THINKING,
      tools: [TAKE_TURN_TOOL],
      tool_choice: { type: "tool", name: TAKE_TURN_TOOL.name },
    },
    "attacker",
  );
  state.attacker_tokens += atk.inputTokens + atk.outputTokens;
  const move = parseAttackerMove(atk.toolInput);
  if (!atk.toolInput) warnings.push("attacker_invalid_tool_output");

  const turn: TurnRecord = {
    turn_no: t,
    attacker_task: move.task,
    attacker_content: move.content,
    guess: null,
    guess_correct: null,
    defender_reply: null,
    verdict_complied: null,
    verdict_reason: null,
  };

  // 2. Guess check
  const guess = move.guess?.trim();
  if (guess) {
    turn.guess = guess;
    if (state.guesses_used < MAX_GUESSES) {
      state.guesses_used += 1;
      const correct = secretsMatch(guess, secret);
      turn.guess_correct = correct;
      if (correct) {
        state.status = "cracked";
        state.end_turn = t;
        return { turn, state, warnings };
      }
    }
    // else: no guesses left — guess recorded, guess_correct stays null.
  }

  // 3. Defender
  const def = await llm.call(
    {
      model: PLAYER_MODEL,
      system: defenderSystemPrompt(secret, input.defensePrompt),
      messages: defenderMessages(history, move.task, move.content),
      max_tokens: DEFENDER_MAX_TOKENS,
      temperature: PLAYER_TEMPERATURE,
      disable_thinking: DISABLE_THINKING,
    },
    "defender",
  );
  turn.defender_reply = def.text.trim();

  // 4. Judge
  if (move.content.trim().length < CONTENT_MIN_CHARS_FOR_JUDGE) {
    turn.verdict_complied = true;
    turn.verdict_reason = "empty_content";
  } else {
    const jr = await llm.call(
      {
        model: JUDGE_MODEL,
        system: JUDGE_SYSTEM_PROMPT,
        messages: [
          { role: "user", content: judgeUserMessage(move.task, move.content, turn.defender_reply) },
        ],
        max_tokens: JUDGE_MAX_TOKENS,
        temperature: JUDGE_TEMPERATURE,
        disable_thinking: DISABLE_THINKING,
        tools: [VERDICT_TOOL],
        tool_choice: { type: "tool", name: VERDICT_TOOL.name },
      },
      "judge",
    );
    const v = jr.toolInput;
    if (v && typeof v.complied === "boolean" && typeof v.reason === "string") {
      turn.verdict_complied = v.complied;
      turn.verdict_reason = v.reason.slice(0, JUDGE_REASON_MAX_CHARS);
    } else {
      turn.verdict_complied = true;
      turn.verdict_reason = "judge_error";
      warnings.push("judge_error");
    }
  }

  if (turn.verdict_complied === false) {
    state.strikes += 1;
    if (state.strikes >= MAX_STRIKES) {
      state.status = "forfeit";
      state.end_turn = t;
    }
  }

  // 5. Exhaustion
  if (state.status === "open" && t === MAX_TURNS) {
    state.status = "exhausted";
    state.end_turn = t;
  }

  return { turn, state, warnings };
}

export function newChannelState(side: "a" | "b"): ChannelState {
  return {
    attacker_side: side,
    status: "open",
    end_turn: null,
    guesses_used: 0,
    strikes: 0,
    attacker_tokens: 0,
  };
}
