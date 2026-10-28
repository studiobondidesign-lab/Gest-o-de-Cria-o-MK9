import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, salt TEXT NOT NULL, color TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, created_by TEXT,
  position REAL NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), name TEXT NOT NULL,
  statuses TEXT NOT NULL, position REAL NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id), parent_id TEXT,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, priority TEXT,
  start_date TEXT, due_date TEXT, position REAL NOT NULL, created_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_list ON tasks(list_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE TABLE IF NOT EXISTS task_assignees (task_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (task_id, user_id));
CREATE TABLE IF NOT EXISTS task_watchers (task_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (task_id, user_id));
CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_tags (task_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (task_id, tag_id));
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, edited_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, user_id TEXT, type TEXT NOT NULL, data TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_task ON activity(task_id);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, user_id TEXT, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, actor_id TEXT, task_id TEXT, type TEXT NOT NULL, text TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
CREATE TABLE IF NOT EXISTS favorites (user_id TEXT NOT NULL, list_id TEXT NOT NULL, PRIMARY KEY (user_id, list_id));
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), name TEXT NOT NULL,
  position REAL NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, user_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  minutes INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_time_task ON time_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_time_user ON time_entries(user_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_lists_space ON lists(space_id);
CREATE INDEX IF NOT EXISTS idx_assignees_user ON task_assignees(user_id);
CREATE INDEX IF NOT EXISTS idx_checklist_task ON checklist_items(task_id);
CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL, depends_on TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (task_id, depends_on)
);
CREATE INDEX IF NOT EXISTS idx_deps_on ON task_dependencies(depends_on);
`;

// Colunas adicionadas depois da primeira versão (bancos já existentes recebem via ALTER TABLE)
const COLUMNS = [
  ['lists', 'folder_id', 'TEXT'],
  ['tasks', 'time_estimate', 'INTEGER'],
  ['comments', 'attachment_id', 'TEXT'],
  ['comments', 'pin_x', 'REAL'],
  ['comments', 'pin_y', 'REAL'],
  ['comments', 'resolved', 'INTEGER NOT NULL DEFAULT 0'],
];

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, col, type] of COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  return db;
}
