-- Runtime settings editable from the admin page (loss protection): kill switch and LLM budgets.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
