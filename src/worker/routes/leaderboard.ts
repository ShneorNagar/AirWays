import { Hono } from "hono";
import type { AppEnv } from "../auth";
import type { RatingRow, SeasonRow, UserRow } from "../db";
import { serializeLeaderboardRow, serializeSeason, serializeSeasonListItem } from "../serializers";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const db = c.env.DB;
  const { results: seasons } = await db.prepare("SELECT * FROM seasons ORDER BY id DESC").all<SeasonRow>();
  const requested = Number(c.req.query("season"));
  const season =
    (Number.isInteger(requested) && seasons.find((s) => s.id === requested)) ||
    seasons.find((s) => s.status === "active") ||
    null;
  if (!season) return c.json({ season: null, seasons: [], rows: [] });

  const { results } = await db
    .prepare(
      `SELECT r.*, u.display_name, u.is_bot FROM ratings r JOIN users u ON u.id = r.user_id
       WHERE r.season_id = ? ORDER BY r.elo DESC, r.matches DESC, u.display_name ASC`,
    )
    .bind(season.id)
    .all<RatingRow & Pick<UserRow, "display_name" | "is_bot">>();
  return c.json({
    season: serializeSeason(season),
    seasons: seasons.map(serializeSeasonListItem),
    rows: results.map((row, i) => serializeLeaderboardRow(i + 1, row)),
  });
});

export default app;
