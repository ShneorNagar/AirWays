// Typed row shapes and small query helpers. Rows never leave the server as-is:
// serializers.ts is the only place rows become API JSON.

export interface UserRow {
  id: string;
  google_sub: string | null;
  email: string | null;
  display_name: string;
  is_admin: number;
  is_bot: number;
  banned: number;
  created_at: number;
}

export interface SeasonRow {
  id: number;
  name: string;
  starts_at: number;
  ends_at: number;
  status: "active" | "closed";
}

export interface VersionRow {
  id: string;
  user_id: string;
  season_id: number;
  version_no: number;
  defense_prompt: string;
  attack_prompt: string;
  is_active: number;
  created_at: number;
}

export interface RatingRow {
  season_id: number;
  user_id: string;
  elo: number;
  wins: number;
  draws: number;
  losses: number;
  matches: number;
}

export interface MatchRow {
  id: string;
  season_id: number;
  version_a_id: string;
  version_b_id: string;
  user_a_id: string;
  user_b_id: string;
  payer_user_id: string;
  status: "pending" | "running" | "completed" | "error" | "cancelled";
  cancel_reason: string | null;
  result: "a" | "b" | "draw" | null;
  rounds_a: number;
  rounds_b: number;
  current_round: number;
  current_turn: number;
  hold_credits: number;
  charged_credits: number;
  cost_usd_micro: number;
  error: string | null;
  hidden: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface RoundRow {
  id: string;
  match_id: string;
  round_no: number;
  secret_a: string;
  secret_b: string;
  status: "running" | "completed";
  winner: "a" | "b" | "draw" | null;
  end_turn: number | null;
  end_reason: string | null;
}

export interface ChannelRow {
  id: string;
  round_id: string;
  attacker_side: "a" | "b";
  status: "open" | "cracked" | "forfeit" | "exhausted" | "stopped";
  end_turn: number | null;
  guesses_used: number;
  strikes: number;
  attacker_tokens: number;
}

export interface TurnRow {
  id: string;
  channel_id: string;
  turn_no: number;
  attacker_task: "translate" | "summarize" | "answer";
  attacker_content: string;
  guess: string | null;
  guess_correct: number | null;
  defender_reply: string | null;
  verdict_complied: number | null;
  verdict_reason: string | null;
  created_at: number;
}

export interface AppealRow {
  id: string;
  turn_id: string;
  match_id: string;
  user_id: string;
  reason: string;
  status: "open" | "accepted" | "rejected";
  admin_note: string | null;
  created_at: number;
  resolved_at: number | null;
}

export const newId = () => crypto.randomUUID();
export const now = () => Date.now();

export async function getActiveSeason(db: D1Database): Promise<SeasonRow | null> {
  return db
    .prepare("SELECT * FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1")
    .first<SeasonRow>();
}

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function getMatch(db: D1Database, id: string): Promise<MatchRow | null> {
  return db.prepare("SELECT * FROM matches WHERE id = ?").bind(id).first<MatchRow>();
}

/** Inserts a rating row with the starting Elo if it does not exist. */
export function ensureRatingStmt(db: D1Database, seasonId: number, userId: string, elo: number): D1PreparedStatement {
  return db
    .prepare("INSERT OR IGNORE INTO ratings (season_id, user_id, elo) VALUES (?, ?, ?)")
    .bind(seasonId, userId, elo);
}
