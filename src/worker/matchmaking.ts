import { ELO_START, OPPONENTS_PER_VERSION } from "../engine/config";
import { cryptoUint32 } from "../engine/secret";
import { ensureRatingStmt, newId, now, type VersionRow } from "./db";

export interface Candidate {
  version_id: string;
  user_id: string;
  elo: number;
}

/**
 * Spec 10.2 step 4: sort by |elo diff| ascending, ties broken randomly (crypto), take N.
 * `random` is injectable for tests.
 */
export function selectOpponents(
  myElo: number,
  candidates: Candidate[],
  n: number = OPPONENTS_PER_VERSION,
  random: () => number = cryptoUint32,
): Candidate[] {
  return candidates
    .map((c) => ({ c, d: Math.abs(c.elo - myElo), r: random() }))
    .sort((x, y) => x.d - y.d || x.r - y.r)
    .slice(0, n)
    .map((x) => x.c);
}

export interface SubmitResult {
  version: VersionRow;
  matchesQueued: number;
}

/** Spec 10.2: create the version and its pending matches in one batch. */
export async function submitVersion(
  db: D1Database,
  userId: string,
  seasonId: number,
  prompts: { defense_prompt: string; attack_prompt: string },
): Promise<SubmitResult> {
  const ts = now();
  const [maxRow, myRating, candRows] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT COALESCE(MAX(version_no), 0) AS max_no FROM versions WHERE user_id = ? AND season_id = ?").bind(userId, seasonId),
    db.prepare("SELECT elo FROM ratings WHERE season_id = ? AND user_id = ?").bind(seasonId, userId),
    db
      .prepare(
        `SELECT v.id AS version_id, v.user_id AS user_id, COALESCE(r.elo, ?) AS elo
         FROM versions v
         JOIN users u ON u.id = v.user_id
         LEFT JOIN ratings r ON r.season_id = v.season_id AND r.user_id = v.user_id
         WHERE v.season_id = ? AND v.is_active = 1 AND v.user_id != ? AND u.banned = 0`,
      )
      .bind(ELO_START, seasonId, userId),
  ]);
  const versionNo = (((maxRow!.results[0] as { max_no: number }) ?? { max_no: 0 }).max_no ?? 0) + 1;
  const myElo = (myRating!.results[0] as { elo: number } | undefined)?.elo ?? ELO_START;
  const opponents = selectOpponents(myElo, candRows!.results as unknown as Candidate[]);

  const version: VersionRow = {
    id: newId(),
    user_id: userId,
    season_id: seasonId,
    version_no: versionNo,
    defense_prompt: prompts.defense_prompt,
    attack_prompt: prompts.attack_prompt,
    is_active: 1,
    created_at: ts,
  };

  const stmts: D1PreparedStatement[] = [
    // 6. cancel not-started matches of previous versions (before deactivating them)
    db
      .prepare(
        `UPDATE matches SET status = 'cancelled', cancel_reason = 'superseded'
         WHERE status = 'pending' AND version_a_id IN (SELECT id FROM versions WHERE user_id = ? AND season_id = ?)`,
      )
      .bind(userId, seasonId),
    // 1. deactivate previous versions, insert the new one
    db.prepare("UPDATE versions SET is_active = 0 WHERE user_id = ? AND season_id = ?").bind(userId, seasonId),
    db
      .prepare(
        "INSERT INTO versions (id, user_id, season_id, version_no, defense_prompt, attack_prompt, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
      )
      .bind(version.id, userId, seasonId, versionNo, version.defense_prompt, version.attack_prompt, ts),
    // 2. ensure rating row
    ensureRatingStmt(db, seasonId, userId, ELO_START),
  ];
  // 5. one pending match per opponent. created_at is offset by index so pagination by
  // created_at is stable and unique per user.
  opponents.forEach((o, i) => {
    stmts.push(
      db
        .prepare(
          `INSERT INTO matches (id, season_id, version_a_id, version_b_id, user_a_id, user_b_id, payer_user_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .bind(newId(), seasonId, version.id, o.version_id, userId, o.user_id, userId, ts + i),
    );
  });
  await db.batch(stmts);
  return { version, matchesQueued: opponents.length };
}
