const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "..", "..", "capx.db"));

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orchestrator TEXT NOT NULL,
  global_budget REAL NOT NULL,
  spent REAL NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  chain_policy_id INTEGER,
  tx_hash TEXT,
  contract_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_budgets (
  policy_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  soft_cap REAL NOT NULL,
  spent REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (policy_id, agent),
  FOREIGN KEY (policy_id) REFERENCES policies(id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL,
  agent TEXT,
  type TEXT NOT NULL,
  amount REAL,
  remaining_global REAL,
  remaining_agent REAL,
  reason TEXT,
  tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
