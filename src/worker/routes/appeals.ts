import { Hono } from "hono";
import { csrf, readJson, requireUser, type AppEnv } from "../auth";
import { newId, now, type AppealRow } from "../db";
import { apiError } from "../errors";
import { serializeAppeal } from "../serializers";

export const APPEALS_PER_DAY = 10;
export const APPEAL_REASON_MAX_CHARS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const app = new Hono<AppEnv>();

app.post("/", csrf, requireUser, async (c) => {
  const user = c.get("user")!;
  const db = c.env.DB;
  const body = await readJson(c);
  const turnId = body?.turn_id;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (typeof turnId !== "string" || !reason) return apiError(c, 400, "bad_request");

  const turn = await db
    .prepare(
      `SELECT t.id, t.verdict_complied, c.attacker_side, m.id AS match_id, m.user_a_id, m.user_b_id, m.hidden
       FROM turns t JOIN channels c ON c.id = t.channel_id JOIN rounds r ON r.id = c.round_id JOIN matches m ON m.id = r.match_id
       WHERE t.id = ?`,
    )
    .bind(turnId)
    .first<{ id: string; verdict_complied: number | null; attacker_side: "a" | "b"; match_id: string; user_a_id: string; user_b_id: string; hidden: number }>();
  if (!turn || (turn.user_a_id !== user.id && turn.user_b_id !== user.id) || turn.hidden === 1) {
    return apiError(c, 404, "not_found");
  }
  // Only the owner of the DEFENDER of that channel may appeal a strike.
  const defenderUser = turn.attacker_side === "a" ? turn.user_b_id : turn.user_a_id;
  if (turn.verdict_complied !== 0 || defenderUser !== user.id) return apiError(c, 422, "not_appealable");

  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM appeals WHERE user_id = ? AND created_at > ?")
    .bind(user.id, now() - DAY_MS)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= APPEALS_PER_DAY) return apiError(c, 429, "rate_limited");

  const appeal: AppealRow = {
    id: newId(),
    turn_id: turn.id,
    match_id: turn.match_id,
    user_id: user.id,
    reason: reason.slice(0, APPEAL_REASON_MAX_CHARS),
    status: "open",
    admin_note: null,
    created_at: now(),
    resolved_at: null,
  };
  const res = await db
    .prepare(
      "INSERT OR IGNORE INTO appeals (id, turn_id, match_id, user_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
    )
    .bind(appeal.id, appeal.turn_id, appeal.match_id, appeal.user_id, appeal.reason, appeal.created_at)
    .run();
  if (res.meta.changes === 0) return apiError(c, 409, "conflict");
  return c.json({ appeal: serializeAppeal(appeal) });
});

export default app;
