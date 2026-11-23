import { Hono } from "hono";
import { optionalUser, type AppEnv } from "../auth";
import { availableBalance, estimatedCreditsPerMatch } from "../credits";
import { getActiveSeason } from "../db";
import { serializeMe, serializeSeason } from "../serializers";

const app = new Hono<AppEnv>();

app.get("/", optionalUser, async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const [balance, season, est] = await Promise.all([
    user ? availableBalance(db, user.id) : Promise.resolve(0),
    getActiveSeason(db),
    estimatedCreditsPerMatch(db),
  ]);
  return c.json({ user: serializeMe(user), balance, season: serializeSeason(season), est_credits_per_match: est });
});

export default app;
