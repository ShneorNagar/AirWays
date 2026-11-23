import { ELO_START, MAX_ACTIVE_MATCHES, SEASON_DAYS } from "../engine/config";
import { BOTS } from "./bots";
import { budgetStatus } from "./budget";
import { ensureRatingStmt, newId, now, type SeasonRow } from "./db";
import type { Env, QueueMsg } from "./env";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A running match with no progress for this long gets its current step re-enqueued. */
export const STALL_MS = 10 * 60 * 1000;

function log(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...data }));
}

/** Spec 10.1 step 1. Returns the active season after rollover. */
export async function ensureSeason(env: Env, ts = now()): Promise<SeasonRow> {
  const db = env.DB;
  let active = await db
    .prepare("SELECT * FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1")
    .first<SeasonRow>();
  if (active && active.ends_at > ts) return active;

  const stmts: D1PreparedStatement[] = [];
  if (active) {
    stmts.push(db.prepare("UPDATE seasons SET status = 'closed' WHERE id = ?").bind(active.id));
    stmts.push(
      db
        .prepare("UPDATE matches SET status = 'cancelled', cancel_reason = 'season_closed' WHERE season_id = ? AND status = 'pending'")
        .bind(active.id),
    );
  }
  const count = await db.prepare("SELECT COUNT(*) AS n FROM seasons").first<{ n: number }>();
  const name = `עונה ${(count?.n ?? 0) + 1}`;
  stmts.push(
    db
      .prepare("INSERT INTO seasons (name, starts_at, ends_at, status) VALUES (?, ?, ?, 'active') RETURNING *")
      .bind(name, ts, ts + SEASON_DAYS * DAY_MS),
  );
  const results = await db.batch<SeasonRow>(stmts);
  const created = results[results.length - 1]!.results[0]!;

  // Bot versions + ratings for the new season.
  const botStmts: D1PreparedStatement[] = [];
  for (const bot of BOTS) {
    botStmts.push(
      db
        .prepare(
          "INSERT INTO versions (id, user_id, season_id, version_no, defense_prompt, attack_prompt, is_active, created_at) VALUES (?, ?, ?, 1, ?, ?, 1, ?)",
        )
        .bind(newId(), bot.id, created.id, bot.defense_prompt, bot.attack_prompt, ts),
      ensureRatingStmt(db, created.id, bot.id, ELO_START),
    );
  }
  await db.batch(botStmts);
  log("season_started", { seasonId: created.id, closedSeasonId: active?.id ?? null });
  active = created;
  return active;
}

/** Spec 10.1 step 2. Returns the number of start_match messages sent. */
export async function startPendingMatches(env: Env): Promise<number> {
  const db = env.DB;
  const running = await db.prepare("SELECT COUNT(*) AS n FROM matches WHERE status = 'running'").first<{ n: number }>();
  // Loss protection: never start more matches than the global budgets can cover.
  const budget = await budgetStatus(db);
  const slots = Math.min(MAX_ACTIVE_MATCHES - (running?.n ?? 0), budget.startableMatches);
  if (slots <= 0) {
    if (budget.startableMatches <= 0) {
      log("budget_blocked", { paused: budget.settings.matchesPaused, todayMicro: budget.todayMicro, monthMicro: budget.monthMicro });
    }
    return 0;
  }
  const { results } = await db
    .prepare("SELECT id FROM matches WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?")
    .bind(slots)
    .all<{ id: string }>();
  if (results.length === 0) return 0;
  await env.MATCH_QUEUE.sendBatch(results.map((r) => ({ body: { type: "start_match", matchId: r.id } satisfies QueueMsg })));
  return results.length;
}

/**
 * Not in the spec's cron list: safety net for a match whose next `step` message was lost
 * (e.g. the Worker died between committing a step and enqueueing the next). Re-sending the
 * current step is safe because steps are idempotent.
 */
export async function recoverStalledMatches(env: Env, ts = now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.current_round, m.current_turn,
            MAX(COALESCE(m.started_at, 0), COALESCE((
              SELECT MAX(t.created_at) FROM turns t
              JOIN channels c ON c.id = t.channel_id
              JOIN rounds r ON r.id = c.round_id
              WHERE r.match_id = m.id), 0)) AS last_activity
     FROM matches m WHERE m.status = 'running'`,
  ).all<{ id: string; current_round: number; current_turn: number; last_activity: number }>();
  const stalled = results.filter((m) => ts - m.last_activity > STALL_MS);
  if (stalled.length === 0) return 0;
  await env.MATCH_QUEUE.sendBatch(
    stalled.map((m) => ({
      body: { type: "step", matchId: m.id, round: m.current_round, turn: m.current_turn } satisfies QueueMsg,
    })),
  );
  for (const m of stalled) log("match_step_requeued", { matchId: m.id });
  return stalled.length;
}

export async function runCron(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now()).run();
  await ensureSeason(env);
  await recoverStalledMatches(env);
  await startPendingMatches(env);
}
