import { MATCH_PRICE_CREDITS } from "../engine/config";
import { newId, now } from "./db";

export type LedgerType =
  | "signup_bonus"
  | "admin_grant"
  | "purchase"
  | "hold"
  | "hold_release"
  | "match_charge"
  | "appeal_refund";

/** available_balance = SUM(ledger.amount); holds are negative. */
export async function availableBalance(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS bal FROM credit_ledger WHERE user_id = ?")
    .bind(userId)
    .first<{ bal: number }>();
  return row?.bal ?? 0;
}

export function ledgerInsertStmt(
  db: D1Database,
  e: { userId: string; amount: number; type: LedgerType; matchId?: string | null; note?: string | null },
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO credit_ledger (id, user_id, amount, type, match_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(newId(), e.userId, e.amount, e.type, e.matchId ?? null, e.note ?? null, now());
}

/** UI estimate: average charge of the last 50 completed matches; fallback: the minimum match price. */
export async function estimatedCreditsPerMatch(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      "SELECT AVG(charged_credits) AS avg, COUNT(*) AS n FROM (SELECT charged_credits FROM matches WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 50)",
    )
    .first<{ avg: number | null; n: number }>();
  if (row && row.n > 0 && row.avg !== null) return Math.ceil(row.avg);
  return MATCH_PRICE_CREDITS;
}
