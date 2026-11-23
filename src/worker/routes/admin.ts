import { Hono } from "hono";
import { csrf, readJson, requireAdmin, type AppEnv } from "../auth";
import { budgetStatus, setSettingStmt } from "../budget";
import { ledgerInsertStmt } from "../credits";
import { getActiveSeason, now, type AppealRow, type TurnRow } from "../db";
import { apiError } from "../errors";
import { serializeAdminAppeal } from "../serializers";

const app = new Hono<AppEnv>();
app.use("*", requireAdmin);

app.get("/stats", async (c) => {
  const db = c.env.DB;
  const season = await getActiveSeason(db);
  const sid = season?.id ?? -1;
  const [users, versions, twoPlus, byStatus, cost, rate] = await db.batch<Record<string, number | string | null>>([
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_bot = 0"),
    db.prepare("SELECT COUNT(*) AS n FROM versions v JOIN users u ON u.id = v.user_id WHERE v.season_id = ? AND u.is_bot = 0").bind(sid),
    db.prepare("SELECT COUNT(*) AS n FROM (SELECT user_id FROM versions WHERE season_id = ? GROUP BY user_id HAVING COUNT(*) >= 2)").bind(sid),
    db.prepare("SELECT status, COUNT(*) AS n FROM matches GROUP BY status"),
    db.prepare(
      "SELECT AVG(cost_usd_micro) AS avg_micro, COALESCE(SUM(charged_credits), 0) AS charged FROM matches WHERE status = 'completed'",
    ),
    // resubmit_after_loss_rate: users who lost >= 1 match with version n, and of those,
    // users who later submitted version n+1 (same season).
    db.prepare(
      `WITH losses AS (
         SELECT v.user_id, v.season_id, v.version_no, MIN(m.completed_at) AS lost_at
         FROM matches m JOIN versions v ON
           (v.id = m.version_a_id AND m.result = 'b') OR (v.id = m.version_b_id AND m.result = 'a')
         JOIN users u ON u.id = v.user_id
         WHERE m.status = 'completed' AND u.is_bot = 0
         GROUP BY v.user_id, v.season_id, v.version_no)
       SELECT COUNT(DISTINCT l.user_id) AS losers,
              COUNT(DISTINCT CASE WHEN EXISTS (
                SELECT 1 FROM versions v2 WHERE v2.user_id = l.user_id AND v2.season_id = l.season_id
                  AND v2.version_no = l.version_no + 1 AND v2.created_at > l.lost_at) THEN l.user_id END) AS resubmitters
       FROM losses l`,
    ),
  ]);
  const r = rate!.results[0] as { losers: number; resubmitters: number };
  const costRow = cost!.results[0] as { avg_micro: number | null; charged: number };
  return c.json({
    users: (users!.results[0] as { n: number }).n,
    versions_this_season: (versions!.results[0] as { n: number }).n,
    users_with_2plus_versions: (twoPlus!.results[0] as { n: number }).n,
    resubmit_after_loss_rate: r.losers > 0 ? r.resubmitters / r.losers : null,
    matches_by_status: Object.fromEntries((byStatus!.results as { status: string; n: number }[]).map((x) => [x.status, x.n])),
    avg_cost_usd: costRow.avg_micro === null ? null : costRow.avg_micro / 1e6,
    credits_charged_total: costRow.charged,
  });
});

// Loss protection: spend overview, kill switch and budgets.
app.get("/settings", async (c) => {
  const b = await budgetStatus(c.env.DB);
  return c.json({
    matches_paused: b.settings.matchesPaused,
    daily_budget_usd: b.settings.dailyBudgetUsd,
    monthly_budget_usd: b.settings.monthlyBudgetUsd,
    spent_today_usd: b.todayMicro / 1e6,
    spent_month_usd: b.monthMicro / 1e6,
    running_matches: b.runningMatches,
    reserved_usd: b.reservedMicro / 1e6,
    startable_matches: b.startableMatches,
  });
});

app.post("/settings", csrf, async (c) => {
  const body = await readJson(c);
  if (!body) return apiError(c, 400, "bad_request");
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  if (body.matches_paused !== undefined) {
    if (typeof body.matches_paused !== "boolean") return apiError(c, 400, "bad_request");
    stmts.push(setSettingStmt(db, "matches_paused", body.matches_paused ? "1" : "0"));
  }
  for (const key of ["daily_budget_usd", "monthly_budget_usd"] as const) {
    if (body[key] === undefined) continue;
    const v = body[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000) return apiError(c, 400, "bad_request");
    stmts.push(setSettingStmt(db, key, String(v)));
  }
  if (stmts.length === 0) return apiError(c, 400, "bad_request");
  await db.batch(stmts);
  return c.json({ ok: true });
});

app.post("/credits", csrf, async (c) => {
  const body = await readJson(c);
  const userId = body?.user_id;
  const amount = body?.amount;
  const note = typeof body?.note === "string" ? body.note.slice(0, 500) : null;
  if (typeof userId !== "string" || typeof amount !== "number" || !Number.isInteger(amount) || amount === 0) {
    return apiError(c, 400, "bad_request");
  }
  const exists = await c.env.DB.prepare("SELECT 1 AS x FROM users WHERE id = ? AND is_bot = 0").bind(userId).first();
  if (!exists) return apiError(c, 404, "not_found");
  await ledgerInsertStmt(c.env.DB, { userId, amount, type: "admin_grant", note }).run();
  return c.json({ ok: true });
});

app.get("/appeals", async (c) => {
  const status = c.req.query("status") ?? "open";
  const db = c.env.DB;
  const { results } = await db
    .prepare(
      `SELECT a.*, u.display_name AS user_name FROM appeals a JOIN users u ON u.id = a.user_id
       WHERE a.status = ? ORDER BY a.created_at ASC LIMIT 100`,
    )
    .bind(status)
    .all<AppealRow & { user_name: string }>();
  const turnIds = results.map((a) => a.turn_id);
  const turns = turnIds.length
    ? (
        await db
          .prepare(`SELECT * FROM turns WHERE id IN (${turnIds.map(() => "?").join(",")})`)
          .bind(...turnIds)
          .all<TurnRow>()
      ).results
    : [];
  return c.json({ appeals: results.map((a) => serializeAdminAppeal(a, turns.find((t) => t.id === a.turn_id) ?? null)) });
});

app.post("/appeals/:id", csrf, async (c) => {
  const db = c.env.DB;
  const body = await readJson(c);
  const status = body?.status;
  const note = typeof body?.admin_note === "string" ? body.admin_note.slice(0, 1000) : null;
  if (status !== "accepted" && status !== "rejected") return apiError(c, 400, "bad_request");
  const appeal = await db.prepare("SELECT * FROM appeals WHERE id = ?").bind(c.req.param("id")).first<AppealRow>();
  if (!appeal) return apiError(c, 404, "not_found");

  const stmts = [
    db.prepare("UPDATE appeals SET status = ?, admin_note = ?, resolved_at = ? WHERE id = ?").bind(status, note, now(), appeal.id),
  ];
  if (status === "accepted") {
    // Refund the match charge to the payer, once per match. Results are not recomputed.
    stmts.push(
      db
        .prepare(
          `INSERT INTO credit_ledger (id, user_id, amount, type, match_id, note, created_at)
           SELECT ?, m.payer_user_id, m.charged_credits, 'appeal_refund', m.id, ?, ? FROM matches m
           WHERE m.id = ? AND m.charged_credits > 0
             AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE match_id = m.id AND type = 'appeal_refund')`,
        )
        .bind(crypto.randomUUID(), `appeal ${appeal.id}`, now(), appeal.match_id),
    );
  }
  await db.batch(stmts);
  return c.json({ ok: true });
});

app.post("/matches/:id/hide", csrf, async (c) => {
  const body = await readJson(c);
  if (typeof body?.hidden !== "boolean") return apiError(c, 400, "bad_request");
  const res = await c.env.DB.prepare("UPDATE matches SET hidden = ? WHERE id = ?").bind(body.hidden ? 1 : 0, c.req.param("id")).run();
  if (res.meta.changes === 0) return apiError(c, 404, "not_found");
  return c.json({ ok: true });
});

app.post("/users/:id/ban", csrf, async (c) => {
  const body = await readJson(c);
  if (typeof body?.banned !== "boolean") return apiError(c, 400, "bad_request");
  const res = await c.env.DB.prepare("UPDATE users SET banned = ? WHERE id = ? AND is_bot = 0").bind(body.banned ? 1 : 0, c.req.param("id")).run();
  if (res.meta.changes === 0) return apiError(c, 404, "not_found");
  return c.json({ ok: true });
});

export default app;
