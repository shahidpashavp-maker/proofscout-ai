PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  claims_json TEXT NOT NULL,
  verifications_json TEXT NOT NULL,
  comparisons_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS research_sessions_project_updated
  ON research_sessions(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS monitoring_tasks (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL CHECK (length(question) BETWEEN 3 AND 500),
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes IN (60, 360, 1440)),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused')) DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT,
  last_error TEXT,
  run_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS monitoring_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES monitoring_tasks(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  sources_json TEXT NOT NULL,
  claims_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS monitoring_runs_task_checked
  ON monitoring_runs(task_id, checked_at DESC);
