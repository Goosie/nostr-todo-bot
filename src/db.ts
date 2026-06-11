import sqlite3 from 'sqlite3';

const DB_PATH = '/tmp/toddy-board.db';

let db: sqlite3.Database;

const SCHEMA = `
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
  status TEXT DEFAULT 'pending',
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
`;

export function initDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        reject(err);
        return;
      }

      // Run schema
      db.exec(SCHEMA, (err) => {
        if (err) {
          reject(err);
        } else {
          console.log('[DB] Initialized');
          resolve();
        }
      });
    });
  });
}

export function getDatabase(): sqlite3.Database {
  return db;
}

// Helper functions
export function run(sql: string, params: any[] = []): Promise<{ lastID: number; changes: number }> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

export function get(sql: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

export function all(sql: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// Project operations
export async function createProject(
  name: string,
  description: string,
  createdBy: string
): Promise<string> {
  const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Math.floor(Date.now() / 1000);

  await run(
    `INSERT INTO projects (id, name, description, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, description, now, now, createdBy]
  );

  return id;
}

export async function getProject(projectId: string): Promise<any> {
  return get('SELECT * FROM projects WHERE id = ?', [projectId]);
}

export async function listProjects(): Promise<any[]> {
  return all('SELECT * FROM projects ORDER BY updated_at DESC');
}

// Workflow step operations
export async function addWorkflowStep(
  projectId: string,
  actor: string,
  action: string,
  dmThreadUrl?: string,
  relayEventId?: string
): Promise<string> {
  const id = `step_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Math.floor(Date.now() / 1000);

  // Get next order
  const lastStep = await get(
    'SELECT step_order FROM workflow_steps WHERE project_id = ? ORDER BY step_order DESC LIMIT 1',
    [projectId]
  );
  const order = (lastStep?.step_order || 0) + 1;

  await run(
    `INSERT INTO workflow_steps (id, project_id, step_order, actor, action, status, dm_thread_url, relay_event_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, order, actor, action, 'pending', dmThreadUrl || null, relayEventId || null, now, now]
  );

  // Update project timestamp
  await run('UPDATE projects SET updated_at = ? WHERE id = ?', [now, projectId]);

  return id;
}

export async function updateWorkflowStep(
  stepId: string,
  status: string,
  updatedBy: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  await run(
    'UPDATE workflow_steps SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?',
    [status, updatedBy, now, stepId]
  );

  // Update project timestamp
  const step = await get('SELECT project_id FROM workflow_steps WHERE id = ?', [stepId]);
  if (step) {
    await run('UPDATE projects SET updated_at = ? WHERE id = ?', [now, step.project_id]);
  }
}

export async function getProjectWorkflow(projectId: string): Promise<any[]> {
  return all(
    'SELECT * FROM workflow_steps WHERE project_id = ? ORDER BY step_order ASC',
    [projectId]
  );
}

// Feedback operations
export async function addFeedback(
  projectId: string,
  eventId: string,
  authorPubkey: string,
  authorName: string,
  content: string
): Promise<void> {
  const id = `feedback_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Math.floor(Date.now() / 1000);

  await run(
    `INSERT INTO feedback (id, project_id, event_id, author_pubkey, author_name, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, eventId, authorPubkey, authorName, content, now]
  );

  // Update project timestamp
  await run('UPDATE projects SET updated_at = ? WHERE id = ?', [now, projectId]);
}

export async function getProjectFeedback(projectId: string): Promise<any[]> {
  return all('SELECT * FROM feedback WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
}
