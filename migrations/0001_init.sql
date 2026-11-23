-- Agent Wars initial schema. Timestamps: unix milliseconds. IDs: crypto.randomUUID() unless noted.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,              -- NULL for bots
  email TEXT,
  display_name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_bot INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,         -- hex SHA-256 of the cookie token
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','closed'))
);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  version_no INTEGER NOT NULL,
  defense_prompt TEXT NOT NULL,
  attack_prompt TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, season_id, version_no)
);
CREATE INDEX idx_versions_active ON versions(season_id, is_active);

CREATE TABLE ratings (
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  elo REAL NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season_id, user_id)
);

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  version_a_id TEXT NOT NULL REFERENCES versions(id),  -- the submitter's new version
  version_b_id TEXT NOT NULL REFERENCES versions(id),  -- the opponent
  user_a_id TEXT NOT NULL REFERENCES users(id),
  user_b_id TEXT NOT NULL REFERENCES users(id),
  payer_user_id TEXT NOT NULL REFERENCES users(id),    -- always user_a_id in MVP
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','error','cancelled')),
  cancel_reason TEXT,                                  -- e.g. 'insufficient_credits'
  result TEXT CHECK (result IN ('a','b','draw')),
  rounds_a INTEGER NOT NULL DEFAULT 0,
  rounds_b INTEGER NOT NULL DEFAULT 0,
  current_round INTEGER NOT NULL DEFAULT 0,
  current_turn INTEGER NOT NULL DEFAULT 0,
  hold_credits INTEGER NOT NULL DEFAULT 0,
  charged_credits INTEGER NOT NULL DEFAULT 0,
  cost_usd_micro INTEGER NOT NULL DEFAULT 0,           -- actual LLM cost, millionths of USD
  error TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX idx_matches_status ON matches(status, created_at);
CREATE INDEX idx_matches_user_a ON matches(user_a_id, created_at);
CREATE INDEX idx_matches_user_b ON matches(user_b_id, created_at);

CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  round_no INTEGER NOT NULL,
  secret_a TEXT NOT NULL,              -- held by A's defender (target of channel b)
  secret_b TEXT NOT NULL,              -- held by B's defender (target of channel a)
  status TEXT NOT NULL CHECK (status IN ('running','completed')),
  winner TEXT CHECK (winner IN ('a','b','draw')),
  end_turn INTEGER,
  end_reason TEXT,                     -- 'cracked' | 'forfeit' | 'tiebreak_guesses' | 'tiebreak_tokens' | 'draw_exhausted' | 'draw_tie'
  UNIQUE (match_id, round_no)
);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  attacker_side TEXT NOT NULL CHECK (attacker_side IN ('a','b')),
  status TEXT NOT NULL CHECK (status IN ('open','cracked','forfeit','exhausted','stopped')),
  end_turn INTEGER,
  guesses_used INTEGER NOT NULL DEFAULT 0,
  strikes INTEGER NOT NULL DEFAULT 0,
  attacker_tokens INTEGER NOT NULL DEFAULT 0,          -- input+output, for tie-break
  UNIQUE (round_id, attacker_side)
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  turn_no INTEGER NOT NULL,
  attacker_task TEXT NOT NULL,
  attacker_content TEXT NOT NULL,
  guess TEXT,
  guess_correct INTEGER,               -- 1/0, NULL if no guess or no guesses left
  defender_reply TEXT,                 -- NULL if cracked this turn
  verdict_complied INTEGER,            -- NULL if cracked this turn
  verdict_reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (channel_id, turn_no)
);

CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  role TEXT NOT NULL CHECK (role IN ('attacker','defender','judge')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd_micro INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_llm_calls_match ON llm_calls(match_id);

CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,             -- signed credits
  type TEXT NOT NULL CHECK (type IN ('signup_bonus','admin_grant','purchase','hold','hold_release','match_charge','appeal_refund')),
  match_id TEXT REFERENCES matches(id),
  external_ref TEXT UNIQUE,            -- payment provider id, for idempotency (Phase 5)
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ledger_user ON credit_ledger(user_id);

CREATE TABLE appeals (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  match_id TEXT NOT NULL REFERENCES matches(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','accepted','rejected')),
  admin_note TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (turn_id, user_id)
);
