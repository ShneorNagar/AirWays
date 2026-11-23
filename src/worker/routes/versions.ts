import { Hono } from "hono";
import { SUBMISSIONS_PER_DAY } from "../../engine/config";
import { computeHoldCredits } from "../../engine/cost";
import { validateVersion } from "../../engine/validation";
import { csrf, readJson, requireUser, type AppEnv } from "../auth";
import { getSettings } from "../budget";
import { availableBalance } from "../credits";
import { getActiveSeason, type VersionRow } from "../db";
import { apiError } from "../errors";
import { submitVersion } from "../matchmaking";
import { serializeOwnVersion } from "../serializers";

const DAY_MS = 24 * 60 * 60 * 1000;
const app = new Hono<AppEnv>();

app.get("/mine", requireUser, async (c) => {
  const user = c.get("user")!;
  const season = await getActiveSeason(c.env.DB);
  if (!season) return c.json({ versions: [] });
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM versions WHERE user_id = ? AND season_id = ? ORDER BY version_no DESC",
  )
    .bind(user.id, season.id)
    .all<VersionRow>();
  return c.json({ versions: results.map(serializeOwnVersion) });
});

/** The user's most recent version in any season (used to pre-fill the submit form). */
app.get("/last", requireUser, async (c) => {
  const user = c.get("user")!;
  const v = await c.env.DB.prepare("SELECT * FROM versions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(user.id)
    .first<VersionRow>();
  return c.json({ version: v ? serializeOwnVersion(v) : null });
});

app.post("/", csrf, requireUser, async (c) => {
  const user = c.get("user")!;
  const db = c.env.DB;
  const body = await readJson(c);
  if (!body) return apiError(c, 400, "bad_request");
  if ((await getSettings(db)).matchesPaused) return apiError(c, 503, "paused");

  const v = validateVersion({ defense_prompt: body.defense_prompt, attack_prompt: body.attack_prompt });
  if (!v.ok) return apiError(c, 422, "validation", { field: v.field, code: v.error_code });

  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM versions WHERE user_id = ? AND created_at > ?")
    .bind(user.id, Date.now() - DAY_MS)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= SUBMISSIONS_PER_DAY) return apiError(c, 429, "rate_limited");

  if ((await availableBalance(db, user.id)) < computeHoldCredits()) return apiError(c, 402, "insufficient_credits");

  const season = await getActiveSeason(db);
  if (!season) return apiError(c, 503, "no_season");

  const { version, matchesQueued } = await submitVersion(db, user.id, season.id, {
    defense_prompt: (body.defense_prompt as string).trim(),
    attack_prompt: (body.attack_prompt as string).trim(),
  });
  return c.json({ version: serializeOwnVersion(version), matches_queued: matchesQueued });
});

export default app;
