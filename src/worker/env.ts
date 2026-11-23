export type QueueMsg =
  | { type: "start_match"; matchId: string }
  | { type: "step"; matchId: string; round: number; turn: number };

export interface Env {
  DB: D1Database;
  MATCH_QUEUE: Queue<QueueMsg>;
  ASSETS: Fetcher;
  APP_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ANTHROPIC_API_KEY: string;
}

export const MATCH_QUEUE_NAME = "matches";
export const MATCH_DLQ_NAME = "matches-dlq";
