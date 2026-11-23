import { runChannelTurn, type ChannelTurnResult } from "../engine/channel";
import { ELO_K, ELO_START } from "../engine/config";
import { assertPricesConfigured, callCostUsdMicro, computeChargeCredits, computeHoldCredits, computeMaxMatchUsdMicro } from "../engine/cost";
import { expectedScore } from "../engine/elo";
import { AnthropicClient, type LLMClient, type UsageCallback } from "../engine/llm";
import { evaluateMatch } from "../engine/match";
import { evaluateRound } from "../engine/round";
import { generateSecret } from "../engine/secret";
import type { ChannelState, MatchResult, Side, TurnRecord } from "../engine/types";
import { budgetStatus } from "./budget";
import {
  ensureRatingStmt,
  getMatch,
  newId,
  now,
  type ChannelRow,
  type MatchRow,
  type RoundRow,
  type TurnRow,
  type UserRow,
  type VersionRow,
} from "./db";
import { MATCH_DLQ_NAME, type Env, type QueueMsg } from "./env";

// ---------- LLM client factory (overridable in tests) ----------

export type LLMFactory = (env: Env, onUsage: UsageCallback) => LLMClient;
const defaultFactory: LLMFactory = (env, onUsage) => new AnthropicClient({ apiKey: env.ANTHROPIC_API_KEY, onUsage });
let llmFactory: LLMFactory = defaultFactory;
export function setLLMFactory(f: LLMFactory | null) {
  llmFactory = f ?? defaultFactory;
}

function log(event: string, data: Record<string, unknown>) {
  // Never log prompts or secrets.
  console.log(JSON.stringify({ event, ...data }));
}

// ---------- Row <-> engine mapping ----------

function channelState(row: ChannelRow): ChannelState {
  return {
    attacker_side: row.attacker_side,
    status: row.status,
    end_turn: row.end_turn,
    guesses_used: row.guesses_used,
    strikes: row.strikes,
    attacker_tokens: row.attacker_tokens,
  };
}

function turnRecord(row: TurnRow): TurnRecord {
  return {
    turn_no: row.turn_no,
    attacker_task: row.attacker_task,
    attacker_content: row.attacker_content,
    guess: row.guess,
    guess_correct: row.guess_correct === null ? null : row.guess_correct === 1,
    defender_reply: row.defender_reply,
    verdict_complied: row.verdict_complied === null ? null : row.verdict_complied === 1,
    verdict_reason: row.verdict_reason,
  };
}

const bool = (b: boolean | null) => (b === null ? null : b ? 1 : 0);

function newRoundStmts(db: D1Database, matchId: string, roundNo: number): D1PreparedStatement[] {
  const roundId = newId();
  return [
    db
      .prepare("INSERT INTO rounds (id, match_id, round_no, secret_a, secret_b, status) VALUES (?, ?, ?, ?, ?, 'running')")
      .bind(roundId, matchId, roundNo, generateSecret(), generateSecret()),
    ...(["a", "b"] as const).map((side) =>
      db.prepare("INSERT INTO channels (id, round_id, attacker_side, status) VALUES (?, ?, ?, 'open')").bind(newId(), roundId, side),
    ),
  ];
}

// ---------- start_match (spec 8.1) ----------

export async function handleStartMatch(env: Env, matchId: string): Promise<void> {
  const db = env.DB;
  const match = await getMatch(db, matchId);
  if (!match || match.status !== "pending") return; // idempotent

  try {
    assertPricesConfigured();
  } catch (err) {
    await db
      .prepare("UPDATE matches SET status = 'error', error = ? WHERE id = ? AND status = 'pending'")
      .bind((err as Error).message, matchId)
      .run();
    log("match_error", { matchId, reason: "pricing" });
    return;
  }

  // Loss protection: kill switch + global budgets. The match stays pending; the cron retries later.
  const budget = await budgetStatus(db);
  if (budget.startableMatches < 1) {
    log("budget_blocked", { matchId, paused: budget.settings.matchesPaused, todayMicro: budget.todayMicro, monthMicro: budget.monthMicro });
    return;
  }

  const payer = await db.prepare("SELECT is_bot FROM users WHERE id = ?").bind(match.payer_user_id).first<{ is_bot: number }>();
  const hold = payer?.is_bot ? 0 : computeHoldCredits();
  const ts = now();
  const roundId = newId();

  // One transaction. Every write is conditional, so a concurrent duplicate or an
  // insufficient balance makes the whole thing a no-op.
  await db.batch([
    db
      .prepare(
        `INSERT INTO credit_ledger (id, user_id, amount, type, match_id, created_at)
         SELECT ?, ?, ?, 'hold', ?, ?
         WHERE (SELECT status FROM matches WHERE id = ?) = 'pending'
           AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE match_id = ? AND type = 'hold')
           AND (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id = ?) >= ?`,
      )
      .bind(newId(), match.payer_user_id, -hold, matchId, ts, matchId, matchId, match.payer_user_id, hold),
    db
      .prepare(
        `UPDATE matches SET status = 'running', hold_credits = ?, started_at = ?, current_round = 1, current_turn = 1
         WHERE id = ? AND status = 'pending'
           AND EXISTS (SELECT 1 FROM credit_ledger WHERE match_id = ? AND type = 'hold')`,
      )
      .bind(hold, ts, matchId, matchId),
    db
      .prepare(
        `INSERT INTO rounds (id, match_id, round_no, secret_a, secret_b, status)
         SELECT ?, ?, 1, ?, ?, 'running'
         WHERE (SELECT status FROM matches WHERE id = ?) = 'running'
           AND NOT EXISTS (SELECT 1 FROM rounds WHERE match_id = ? AND round_no = 1)`,
      )
      .bind(roundId, matchId, generateSecret(), generateSecret(), matchId, matchId),
    ...(["a", "b"] as const).map((side) =>
      db
        .prepare(
          `INSERT INTO channels (id, round_id, attacker_side, status)
           SELECT ?, ?, ?, 'open' WHERE EXISTS (SELECT 1 FROM rounds WHERE id = ?)`,
        )
        .bind(newId(), roundId, side, roundId),
    ),
  ]);

  const after = await getMatch(db, matchId);
  if (after?.status === "running") {
    log("match_started", { matchId, hold });
    await env.MATCH_QUEUE.send({ type: "step", matchId, round: 1, turn: 1 });
  } else if (after?.status === "pending") {
    await db
      .prepare("UPDATE matches SET status = 'cancelled', cancel_reason = 'insufficient_credits' WHERE id = ? AND status = 'pending'")
      .bind(matchId)
      .run();
    log("match_cancelled", { matchId, reason: "insufficient_credits" });
  }
}

// ---------- step (spec 8.2) ----------

interface StepData {
  match: MatchRow;
  round: RoundRow;
  channels: ChannelRow[];
  turns: TurnRow[];
  versionA: VersionRow;
  versionB: VersionRow;
  costSoFarMicro: number;
}

async function loadStep(db: D1Database, matchId: string, roundNo: number): Promise<StepData | null> {
  const roundSub = "(SELECT id FROM rounds WHERE match_id = ? AND round_no = ?)";
  const [m, r, ch, t, v, cost] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT * FROM matches WHERE id = ?").bind(matchId),
    db.prepare("SELECT * FROM rounds WHERE match_id = ? AND round_no = ?").bind(matchId, roundNo),
    db.prepare(`SELECT * FROM channels WHERE round_id = ${roundSub}`).bind(matchId, roundNo),
    db
      .prepare(`SELECT t.* FROM turns t JOIN channels c ON c.id = t.channel_id WHERE c.round_id = ${roundSub} ORDER BY t.turn_no`)
      .bind(matchId, roundNo),
    db
      .prepare("SELECT v.* FROM versions v JOIN matches m ON v.id IN (m.version_a_id, m.version_b_id) WHERE m.id = ?")
      .bind(matchId),
    db.prepare("SELECT COALESCE(SUM(cost_usd_micro), 0) AS total FROM llm_calls WHERE match_id = ?").bind(matchId),
  ]);
  const match = m!.results[0] as unknown as MatchRow | undefined;
  const round = r!.results[0] as unknown as RoundRow | undefined;
  if (!match || !round) return null;
  const versions = v!.results as unknown as VersionRow[];
  const versionA = versions.find((x) => x.id === match.version_a_id);
  const versionB = versions.find((x) => x.id === match.version_b_id);
  if (!versionA || !versionB) return null;
  return {
    match,
    round,
    channels: ch!.results as unknown as ChannelRow[],
    turns: t!.results as unknown as TurnRow[],
    versionA,
    versionB,
    costSoFarMicro: (cost!.results[0] as { total: number }).total,
  };
}

export async function handleStep(env: Env, msg: { matchId: string; round: number; turn: number }): Promise<void> {
  const db = env.DB;
  const { matchId, round: r, turn: t } = msg;
  const data = await loadStep(db, matchId, r);
  if (!data) return;
  const { match, round } = data;
  if (match.status !== "running" || match.current_round !== r || match.current_turn !== t) return; // stale/duplicate

  // Loss protection: a match that already spent its worst-case budget ends now, scored on
  // the rounds completed so far (the unfinished round counts as a draw).
  if (data.costSoFarMicro >= computeMaxMatchUsdMicro()) {
    await stopForCostCap(db, data, r, t);
    return;
  }

  const chRows: Record<Side, ChannelRow> = {
    a: data.channels.find((c) => c.attacker_side === "a")!,
    b: data.channels.find((c) => c.attacker_side === "b")!,
  };
  const states: Record<Side, ChannelState> = { a: channelState(chRows.a), b: channelState(chRows.b) };
  const history: Record<Side, TurnRecord[]> = { a: [], b: [] };
  const hasTurnT: Record<Side, boolean> = { a: false, b: false };
  for (const row of data.turns) {
    const side = row.channel_id === chRows.a.id ? "a" : "b";
    if (row.turn_no < t) history[side].push(turnRecord(row));
    if (row.turn_no === t) hasTurnT[side] = true;
  }
  // channel a: attacker of A vs defender of B (holds secret_b); channel b: the reverse.
  const setup = {
    a: { attack: data.versionA.attack_prompt, defense: data.versionB.defense_prompt, secret: round.secret_b },
    b: { attack: data.versionB.attack_prompt, defense: data.versionA.defense_prompt, secret: round.secret_a },
  } as const;

  // Usage is written as it arrives, so cost is recorded even if a later call fails.
  const onUsage: UsageCallback = async (u) => {
    await db
      .prepare(
        "INSERT INTO llm_calls (id, match_id, role, model, input_tokens, output_tokens, cost_usd_micro, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(newId(), matchId, u.role, u.model, u.inputTokens, u.outputTokens, callCostUsdMicro(u.model, u.inputTokens, u.outputTokens), now())
      .run();
  };
  const llm = llmFactory(env, onUsage);

  const toRun = (["a", "b"] as const).filter((s) => states[s].status === "open" && !hasTurnT[s]);
  const settled = await Promise.allSettled(
    toRun.map((side) =>
      runChannelTurn({
        llm,
        turnNo: t,
        secret: setup[side].secret,
        attackPrompt: setup[side].attack,
        defensePrompt: setup[side].defense,
        state: states[side],
        history: history[side],
      }),
    ),
  );

  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  let failure: unknown = null;
  settled.forEach((res, i) => {
    const side = toRun[i]!;
    if (res.status === "rejected") {
      failure ??= res.reason;
      return;
    }
    const { turn, state, warnings }: ChannelTurnResult = res.value;
    for (const w of warnings) console.warn(JSON.stringify({ event: "turn_warning", matchId, round: r, turn: t, side, warning: w }));
    states[side] = state;
    stmts.push(
      db
        .prepare(
          `INSERT INTO turns (id, channel_id, turn_no, attacker_task, attacker_content, guess, guess_correct, defender_reply, verdict_complied, verdict_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId(), chRows[side].id, t, turn.attacker_task, turn.attacker_content, turn.guess, bool(turn.guess_correct),
          turn.defender_reply, bool(turn.verdict_complied), turn.verdict_reason, ts,
        ),
      db
        .prepare("UPDATE channels SET status = ?, end_turn = ?, guesses_used = ?, strikes = ?, attacker_tokens = ? WHERE id = ?")
        .bind(state.status, state.end_turn, state.guesses_used, state.strikes, state.attacker_tokens, chRows[side].id),
    );
  });

  if (failure) {
    // Persist the channel(s) that succeeded, then let Queues retry the message.
    if (stmts.length) await db.batch(stmts);
    throw failure;
  }

  const guard = "WHERE id = ? AND status = 'running' AND current_round = ? AND current_turn = ?";
  const outcome = evaluateRound(t, states.a, states.b);
  let next: QueueMsg | null = null;
  let finalized: { result: MatchResult; charge: number; actualMicro: number } | null = null;

  if (!outcome.ended) {
    stmts.push(db.prepare(`UPDATE matches SET current_turn = ? ${guard}`).bind(t + 1, matchId, r, t));
    next = { type: "step", matchId, round: r, turn: t + 1 };
  } else {
    stmts.push(
      db.prepare("UPDATE channels SET status = 'stopped' WHERE round_id = ? AND status = 'open'").bind(round.id),
      db
        .prepare("UPDATE rounds SET status = 'completed', winner = ?, end_turn = ?, end_reason = ? WHERE id = ?")
        .bind(outcome.winner, outcome.end_turn, outcome.end_reason, round.id),
    );
    const roundsA = match.rounds_a + (outcome.winner === "a" ? 1 : 0);
    const roundsB = match.rounds_b + (outcome.winner === "b" ? 1 : 0);
    const m = evaluateMatch(roundsA, roundsB, r);
    if (!m.decided) {
      stmts.push(
        ...newRoundStmts(db, matchId, r + 1),
        db
          .prepare(`UPDATE matches SET rounds_a = ?, rounds_b = ?, current_round = ?, current_turn = 1 ${guard}`)
          .bind(roundsA, roundsB, r + 1, matchId, r, t),
      );
      next = { type: "step", matchId, round: r + 1, turn: 1 };
    } else {
      const fin = await finalizeStmts(db, match, m.result, roundsA, roundsB, { r, t });
      stmts.push(...fin.stmts);
      finalized = { result: m.result, charge: fin.charge, actualMicro: fin.actualMicro };
    }
  }

  await db.batch(stmts);
  if (outcome.ended) log("round_ended", { matchId, round: r, winner: outcome.winner, endReason: outcome.end_reason, endTurn: outcome.end_turn });
  if (finalized) log("match_finalized", { matchId, result: finalized.result, chargedCredits: finalized.charge, costUsdMicro: finalized.actualMicro });
  if (next) await env.MATCH_QUEUE.send(next);
}

async function stopForCostCap(db: D1Database, data: StepData, r: number, t: number): Promise<void> {
  const { match, round } = data;
  const m = evaluateMatch(match.rounds_a, match.rounds_b, Number.MAX_SAFE_INTEGER);
  const result: MatchResult = m.decided ? m.result : "draw";
  const fin = await finalizeStmts(db, match, result, match.rounds_a, match.rounds_b, { r, t });
  await db.batch([
    db.prepare("UPDATE channels SET status = 'stopped' WHERE round_id = ? AND status = 'open'").bind(round.id),
    db
      .prepare("UPDATE rounds SET status = 'completed', winner = 'draw', end_turn = ?, end_reason = 'cost_cap' WHERE id = ? AND status = 'running'")
      .bind(t - 1, round.id),
    ...fin.stmts,
  ]);
  log("match_cost_cap", { matchId: match.id, round: r, turn: t, costUsdMicro: data.costSoFarMicro });
  log("match_finalized", { matchId: match.id, result, chargedCredits: fin.charge, costUsdMicro: fin.actualMicro });
}

// ---------- finalize (spec 8.3) ----------

async function finalizeStmts(
  db: D1Database,
  match: MatchRow,
  result: MatchResult,
  roundsA: number,
  roundsB: number,
  at: { r: number; t: number },
): Promise<{ stmts: D1PreparedStatement[]; charge: number; actualMicro: number }> {
  const [sumRes, payerRes, ratingsRes] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT COALESCE(SUM(cost_usd_micro), 0) AS total FROM llm_calls WHERE match_id = ?").bind(match.id),
    db.prepare("SELECT is_bot FROM users WHERE id = ?").bind(match.payer_user_id),
    db.prepare("SELECT user_id, elo FROM ratings WHERE season_id = ? AND user_id IN (?, ?)").bind(match.season_id, match.user_a_id, match.user_b_id),
  ]);
  const actualMicro = (sumRes!.results[0] as { total: number }).total;
  const payerIsBot = (payerRes!.results[0] as Pick<UserRow, "is_bot"> | undefined)?.is_bot === 1;
  const charge = payerIsBot ? 0 : computeChargeCredits(actualMicro, match.hold_credits);
  const eloOf = (uid: string) => (ratingsRes!.results as { user_id: string; elo: number }[]).find((x) => x.user_id === uid)?.elo ?? ELO_START;
  const ra = eloOf(match.user_a_id);
  const rb = eloOf(match.user_b_id);
  const sa = result === "a" ? 1 : result === "draw" ? 0.5 : 0;
  // Apply as deltas so concurrent finalizations for the same user never lose an update.
  const da = Math.round(ELO_K * (sa - expectedScore(ra, rb)) * 10) / 10;
  const db_ = Math.round(ELO_K * (1 - sa - expectedScore(rb, ra)) * 10) / 10;

  const stillRunning = "(SELECT status FROM matches WHERE id = ?) = 'running'";
  const ratingUpdate = (uid: string, delta: number, s: number) =>
    db
      .prepare(
        `UPDATE ratings SET elo = ROUND(elo + ?, 1), wins = wins + ?, draws = draws + ?, losses = losses + ?, matches = matches + 1
         WHERE season_id = ? AND user_id = ? AND ${stillRunning}`,
      )
      .bind(delta, s === 1 ? 1 : 0, s === 0.5 ? 1 : 0, s === 0 ? 1 : 0, match.season_id, uid, match.id);

  const ts = now();
  const condLedger = (amount: number, type: "hold_release" | "match_charge") =>
    db
      .prepare(
        `INSERT INTO credit_ledger (id, user_id, amount, type, match_id, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${stillRunning}`,
      )
      .bind(newId(), match.payer_user_id, amount, type, match.id, ts, match.id);

  const stmts = [
    ensureRatingStmt(db, match.season_id, match.user_a_id, ELO_START),
    ensureRatingStmt(db, match.season_id, match.user_b_id, ELO_START),
    ratingUpdate(match.user_a_id, da, sa),
    ratingUpdate(match.user_b_id, db_, 1 - sa),
    condLedger(match.hold_credits, "hold_release"),
    condLedger(-charge, "match_charge"),
    // Must be last: the statements above are conditional on status = 'running'.
    db
      .prepare(
        `UPDATE matches SET status = 'completed', result = ?, rounds_a = ?, rounds_b = ?, charged_credits = ?, cost_usd_micro = ?, completed_at = ?
         WHERE id = ? AND status = 'running' AND current_round = ? AND current_turn = ?`,
      )
      .bind(result, roundsA, roundsB, charge, actualMicro, ts, match.id, at.r, at.t),
  ];
  return { stmts, charge, actualMicro };
}

// ---------- DLQ (spec 8.2.6) ----------

export async function handleDeadLetter(env: Env, msg: QueueMsg): Promise<void> {
  const db = env.DB;
  const match = await getMatch(db, msg.matchId);
  if (!match || match.status === "completed" || match.status === "cancelled" || match.status === "error") return;
  const error = `processing failed after retries (${msg.type})`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO credit_ledger (id, user_id, amount, type, match_id, created_at)
         SELECT ?, ?, -amount, 'hold_release', match_id, ? FROM credit_ledger
         WHERE match_id = ? AND type = 'hold'
           AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE match_id = ? AND type = 'hold_release')
           AND (SELECT status FROM matches WHERE id = ?) IN ('pending', 'running')`,
      )
      .bind(newId(), match.payer_user_id, now(), match.id, match.id, match.id),
    db
      .prepare("UPDATE matches SET status = 'error', error = ?, completed_at = ? WHERE id = ? AND status IN ('pending', 'running')")
      .bind(error, now(), match.id),
  ]);
  log("match_error", { matchId: match.id, messageType: msg.type });
}

// ---------- consumer entry ----------

export async function handleQueue(batch: MessageBatch<QueueMsg>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const msg = message.body;
    if (batch.queue === MATCH_DLQ_NAME) {
      await handleDeadLetter(env, msg);
    } else if (msg.type === "start_match") {
      await handleStartMatch(env, msg.matchId);
    } else if (msg.type === "step") {
      await handleStep(env, msg);
    }
    // Errors propagate: the runtime retries the message (max_batch_size is 1).
    message.ack();
  }
}

