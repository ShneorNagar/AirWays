import { Hono } from "hono";
import { loadUser, requireUser, type AppEnv } from "../auth";
import type { ChannelRow, MatchRow, RoundRow, TurnRow } from "../db";
import { apiError } from "../errors";
import { serializeMatchListItem, serializeMatchReplay } from "../serializers";

const PAGE_SIZE = 20;
const app = new Hono<AppEnv>();

app.get("/mine", requireUser, async (c) => {
  const user = c.get("user")!;
  const cursor = Number(c.req.query("cursor"));
  const before = Number.isFinite(cursor) && cursor > 0 ? cursor : Number.MAX_SAFE_INTEGER;
  const { results } = await c.env.DB.prepare(
    `SELECT m.*, CASE WHEN m.user_a_id = ?1 THEN ub.display_name ELSE ua.display_name END AS opponent_name
     FROM matches m
     JOIN users ua ON ua.id = m.user_a_id
     JOIN users ub ON ub.id = m.user_b_id
     WHERE (m.user_a_id = ?1 OR m.user_b_id = ?1) AND m.hidden = 0 AND m.created_at < ?2
     ORDER BY m.created_at DESC LIMIT ?3`,
  )
    .bind(user.id, before, PAGE_SIZE)
    .all<MatchRow & { opponent_name: string }>();
  return c.json({
    matches: results.map((m) => serializeMatchListItem(m, user.id, m.opponent_name)),
    next_cursor: results.length === PAGE_SIZE ? results[results.length - 1]!.created_at : null,
  });
});

app.get("/:id", async (c) => {
  const user = await loadUser(c);
  if (!user) return apiError(c, 401, "unauthorized");
  if (user.banned) return apiError(c, 403, "banned");
  const db = c.env.DB;
  const id = c.req.param("id");
  const [m, r, ch, t] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT m.*, ua.display_name AS name_a, ub.display_name AS name_b FROM matches m
         JOIN users ua ON ua.id = m.user_a_id JOIN users ub ON ub.id = m.user_b_id WHERE m.id = ?`,
      )
      .bind(id),
    db.prepare("SELECT * FROM rounds WHERE match_id = ?").bind(id),
    db.prepare("SELECT c.* FROM channels c JOIN rounds r ON r.id = c.round_id WHERE r.match_id = ?").bind(id),
    db
      .prepare("SELECT t.* FROM turns t JOIN channels c ON c.id = t.channel_id JOIN rounds r ON r.id = c.round_id WHERE r.match_id = ?")
      .bind(id),
  ]);
  const match = m!.results[0] as (MatchRow & { name_a: string; name_b: string }) | undefined;
  const isAdmin = user.is_admin === 1;
  const isParticipant = !!match && (match.user_a_id === user.id || match.user_b_id === user.id);
  if (!match || (!isAdmin && (!isParticipant || match.hidden === 1))) return apiError(c, 404, "not_found");

  return c.json(
    serializeMatchReplay({
      match,
      rounds: r!.results as unknown as RoundRow[],
      channels: ch!.results as unknown as ChannelRow[],
      turns: t!.results as unknown as TurnRow[],
      names: { a: match.name_a, b: match.name_b },
      meId: user.id,
      isAdmin,
    }),
  );
});

export default app;
