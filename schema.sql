-- Projects (workflows)
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);

-- Workflow steps
CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- pending, in_progress, done, blocked
  dm_thread_url TEXT,
  relay_event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- External feedback (replies to published posts)
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  author_pubkey TEXT NOT NULL,
  author_name TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_project_steps ON workflow_steps(project_id);
CREATE INDEX IF NOT EXISTS idx_project_feedback ON feedback(project_id);
