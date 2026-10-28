// MK9 Tarefas: servidor HTTP sem dependências externas (Node 22+, node:sqlite).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const REGISTRATION_CODE = process.env.REGISTRATION_CODE || '';
const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '').toLowerCase();
const SESSION_DAYS = 30;
const MAX_UPLOAD = 25 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = openDb(path.join(DATA_DIR, 'mk9.db'));

// ---------- utilidades ----------
const now = () => new Date().toISOString();
const uid = () => crypto.randomBytes(9).toString('base64url');
// Tons dessaturados: o design system reserva o cobalto (#5266eb) para a ação principal.
const PALETTE = ['#7d8ce0', '#5fae8f', '#c9a55c', '#9b87d9', '#d98a8a', '#6fb3c4', '#b58ac9', '#a3a86b', '#8a9bb0', '#c98f6b'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };
const notFound = (msg = 'Não encontrado') => { throw new HttpError(404, msg); };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(token, maxAge) {
  return `mk9_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Arquivo muito grande');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { bad('JSON inválido'); }
}
function send(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isDate = (v) => v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));

// ---------- eventos em tempo real (SSE) ----------
const clients = new Set();
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- autenticação ----------
function currentUser(req) {
  const token = parseCookies(req).mk9_session;
  if (!token) return null;
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(token, now());
  return row || null;
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, color: u.color, role: u.role, created_at: u.created_at };
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(token, userId, expires, now());
  return token;
}

const loginAttempts = new Map();
function throttle(key) {
  const t = Date.now();
  const list = (loginAttempts.get(key) || []).filter((x) => t - x < 15 * 60 * 1000);
  if (list.length >= 10) throw new HttpError(429, 'Muitas tentativas. Tente novamente em alguns minutos.');
  list.push(t);
  loginAttempts.set(key, list);
}

// ---------- consultas ----------
const DEFAULT_STATUSES = [
  { id: 'todo', name: 'A fazer', color: '#70707d', type: 'open' },
  { id: 'doing', name: 'Em produção', color: '#7d8ce0', type: 'active' },
  { id: 'review', name: 'Em revisão', color: '#c9a55c', type: 'active' },
  { id: 'approval', name: 'Aprovação cliente', color: '#9b87d9', type: 'active' },
  { id: 'done', name: 'Concluído', color: '#5fae8f', type: 'done' },
];

function listRow(l) { return { ...l, statuses: JSON.parse(l.statuses) }; }

function hydrateTasks(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const assignees = db.prepare(`SELECT task_id, user_id FROM task_assignees WHERE task_id IN (${marks})`).all(...ids);
  const tags = db.prepare(`SELECT task_id, tag_id FROM task_tags WHERE task_id IN (${marks})`).all(...ids);
  const subs = db.prepare(`SELECT parent_id, COUNT(*) n, SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) d
    FROM tasks WHERE parent_id IN (${marks}) AND archived = 0 GROUP BY parent_id`).all(...ids);
  const comments = db.prepare(`SELECT task_id, COUNT(*) n FROM comments WHERE task_id IN (${marks}) GROUP BY task_id`).all(...ids);
  const checks = db.prepare(`SELECT task_id, COUNT(*) n, SUM(done) d FROM checklist_items WHERE task_id IN (${marks}) GROUP BY task_id`).all(...ids);
  const files = db.prepare(`SELECT task_id, COUNT(*) n FROM attachments WHERE task_id IN (${marks}) GROUP BY task_id`).all(...ids);
  const times = db.prepare(`SELECT task_id, SUM(minutes) m FROM time_entries WHERE task_id IN (${marks}) AND ended_at IS NOT NULL GROUP BY task_id`).all(...ids);
  const running = db.prepare(`SELECT task_id, user_id, started_at FROM time_entries WHERE task_id IN (${marks}) AND ended_at IS NULL`).all(...ids);
  const deps = db.prepare(`SELECT d.task_id, d.depends_on, t.completed_at FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on
    WHERE d.task_id IN (${marks}) AND t.archived = 0`).all(...ids);
  const by = (arr, key) => arr.reduce((m, r) => ((m[r[key]] ||= []).push(r), m), {});
  const aBy = by(assignees, 'task_id'), tBy = by(tags, 'task_id');
  const sBy = Object.fromEntries(subs.map((r) => [r.parent_id, r]));
  const cBy = Object.fromEntries(comments.map((r) => [r.task_id, r.n]));
  const kBy = Object.fromEntries(checks.map((r) => [r.task_id, r]));
  const fBy = Object.fromEntries(files.map((r) => [r.task_id, r.n]));
  const tmBy = Object.fromEntries(times.map((r) => [r.task_id, r.m]));
  const rBy = by(running, 'task_id'), dBy = by(deps, 'task_id');
  return rows.map((r) => ({
    ...r,
    assignees: (aBy[r.id] || []).map((a) => a.user_id),
    tags: (tBy[r.id] || []).map((t) => t.tag_id),
    subtasks: { total: sBy[r.id]?.n || 0, done: sBy[r.id]?.d || 0 },
    checklist: { total: kBy[r.id]?.n || 0, done: kBy[r.id]?.d || 0 },
    comment_count: cBy[r.id] || 0,
    attachment_count: fBy[r.id] || 0,
    time_spent: tmBy[r.id] || 0,
    timers: (rBy[r.id] || []).map((x) => ({ user_id: x.user_id, started_at: x.started_at })),
    waiting_on: (dBy[r.id] || []).map((x) => x.depends_on),
    blocked: (dBy[r.id] || []).some((x) => !x.completed_at),
  }));
}

function getTask(id) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) notFound('Tarefa não encontrada');
  return hydrateTasks([t])[0];
}

function taskDetail(id) {
  const task = getTask(id);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(task.list_id);
  return {
    task,
    list: list ? listRow(list) : null,
    parent: task.parent_id ? db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(task.parent_id) : null,
    subtasks: hydrateTasks(db.prepare('SELECT * FROM tasks WHERE parent_id = ? AND archived = 0 ORDER BY position, created_at').all(id)),
    checklist: db.prepare('SELECT * FROM checklist_items WHERE task_id = ? ORDER BY position, created_at').all(id),
    comments: db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at').all(id),
    activity: db.prepare('SELECT * FROM activity WHERE task_id = ? ORDER BY created_at').all(id).map((a) => ({ ...a, data: JSON.parse(a.data || '{}') })),
    attachments: db.prepare('SELECT id, task_id, user_id, filename, mime, size, created_at FROM attachments WHERE task_id = ? ORDER BY created_at').all(id),
    watchers: db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(id).map((r) => r.user_id),
    time_entries: db.prepare('SELECT * FROM time_entries WHERE task_id = ? ORDER BY started_at DESC').all(id),
    waiting_on: db.prepare(`SELECT t.id, t.title, t.list_id, t.status, t.completed_at FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on
      WHERE d.task_id = ? AND t.archived = 0`).all(id),
    blocking: db.prepare(`SELECT t.id, t.title, t.list_id, t.status, t.completed_at FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
      WHERE d.depends_on = ? AND t.archived = 0`).all(id),
  };
}

function logActivity(taskId, userId, type, data = {}) {
  db.prepare('INSERT INTO activity (id, task_id, user_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uid(), taskId, userId, type, JSON.stringify(data), now());
}

function watch(taskId, userId) {
  db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)').run(taskId, userId);
}

function notify(userIds, actorId, taskId, type, text) {
  const stmt = db.prepare('INSERT INTO notifications (id, user_id, actor_id, task_id, type, text, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)');
  const sent = new Set();
  for (const u of userIds) {
    if (!u || u === actorId || sent.has(u)) continue;
    sent.add(u);
    stmt.run(uid(), u, actorId, taskId, type, text, now());
  }
  if (sent.size) broadcast({ type: 'notification', users: [...sent] });
}
function watchersOf(taskId) {
  return db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(taskId).map((r) => r.user_id);
}

function nextPosition(table, where, ...args) {
  const r = db.prepare(`SELECT MAX(position) p FROM ${table} WHERE ${where}`).get(...args);
  return (r?.p ?? 0) + 1000;
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- rotas ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false });
};

// Auth
route('GET', '/api/config', () => ({ registrationCode: !!REGISTRATION_CODE, emailDomain: ALLOWED_EMAIL_DOMAIN || null }), { auth: false });

route('POST', '/api/auth/register', async ({ req, res }) => {
  const b = await readJson(req);
  throttle('reg:' + req.socket.remoteAddress);
  const name = str(b.name, 80), email = str(b.email, 160).toLowerCase(), password = typeof b.password === 'string' ? b.password : '';
  if (!name) bad('Informe seu nome');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('E-mail inválido');
  if (password.length < 8) bad('A senha precisa ter pelo menos 8 caracteres');
  if (ALLOWED_EMAIL_DOMAIN && !email.endsWith('@' + ALLOWED_EMAIL_DOMAIN)) bad(`Use um e-mail @${ALLOWED_EMAIL_DOMAIN}`);
  if (REGISTRATION_CODE && b.code !== REGISTRATION_CODE) bad('Código de convite inválido');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) bad('Já existe uma conta com esse e-mail');
  const { hash, salt } = hashPassword(password);
  const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const id = uid();
  db.prepare(`INSERT INTO users (id, name, email, password_hash, salt, color, role, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(id, name, email, hash, salt, PALETTE[count % PALETTE.length], count === 0 ? 'admin' : 'member', now());
  const token = createSession(id);
  broadcast({ type: 'users' });
  send(res, 201, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) }, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
}, { auth: false });

route('POST', '/api/auth/login', async ({ req, res }) => {
  const b = await readJson(req);
  const email = str(b.email, 160).toLowerCase();
  throttle('login:' + email);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !u.active || !verifyPassword(String(b.password || ''), u.salt, u.password_hash)) throw new HttpError(401, 'E-mail ou senha incorretos');
  loginAttempts.delete('login:' + email);
  const token = createSession(u.id);
  send(res, 200, { user: publicUser(u) }, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
}, { auth: false });

route('POST', '/api/auth/logout', ({ req, res }) => {
  const token = parseCookies(req).mk9_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
}, { auth: false });

route('GET', '/api/me', ({ user }) => ({ user: publicUser(user) }));

route('PATCH', '/api/me', async ({ req, user }) => {
  const b = await readJson(req);
  if (b.name !== undefined) {
    const name = str(b.name, 80);
    if (!name) bad('Nome não pode ficar vazio');
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
  }
  if (b.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(b.color)) bad('Cor inválida');
    db.prepare('UPDATE users SET color = ? WHERE id = ?').run(b.color, user.id);
  }
  if (b.newPassword !== undefined) {
    if (!verifyPassword(String(b.currentPassword || ''), user.salt, user.password_hash)) bad('Senha atual incorreta');
    if (String(b.newPassword).length < 8) bad('A nova senha precisa ter pelo menos 8 caracteres');
    const { hash, salt } = hashPassword(String(b.newPassword));
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, user.id);
  }
  broadcast({ type: 'users' });
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
});

route('PATCH', '/api/users/:id', async ({ req, user, params }) => {
  if (user.role !== 'admin') throw new HttpError(403, 'Apenas administradores');
  const b = await readJson(req);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id) || notFound();
  if (target.id === user.id) bad('Você não pode alterar seu próprio acesso');
  if (b.role !== undefined) {
    if (!['admin', 'member'].includes(b.role)) bad('Papel inválido');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, target.id);
  }
  if (b.active !== undefined) {
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, target.id);
    if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  }
  broadcast({ type: 'users' });
  return { ok: true };
});

// Bootstrap
route('GET', '/api/bootstrap', ({ user }) => ({
  me: publicUser(user),
  users: db.prepare('SELECT id, name, email, color, role, active, created_at FROM users ORDER BY name').all(),
  spaces: db.prepare('SELECT * FROM spaces WHERE archived = 0 ORDER BY position, created_at').all(),
  folders: db.prepare('SELECT * FROM folders WHERE archived = 0 ORDER BY position, created_at').all(),
  lists: db.prepare('SELECT * FROM lists WHERE archived = 0 ORDER BY position, created_at').all().map(listRow),
  timer: db.prepare(`SELECT e.id, e.task_id, e.started_at, t.title FROM time_entries e JOIN tasks t ON t.id = e.task_id
    WHERE e.user_id = ? AND e.ended_at IS NULL`).get(user.id) || null,
  tags: db.prepare('SELECT * FROM tags ORDER BY name').all(),
  unread: db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0').get(user.id).n,
  favorites: db.prepare('SELECT list_id FROM favorites WHERE user_id = ?').all(user.id).map((r) => r.list_id),
}));

// Espaços
route('POST', '/api/spaces', async ({ req, user }) => {
  const b = await readJson(req);
  const name = str(b.name, 80) || bad('Informe o nome do espaço');
  const id = uid();
  tx(() => {
    db.prepare('INSERT INTO spaces (id, name, color, created_by, position, archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(id, name, /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : PALETTE[0], user.id, nextPosition('spaces', '1=1'), now());
    db.prepare('INSERT INTO lists (id, space_id, name, statuses, position, archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(uid(), id, 'Geral', JSON.stringify(DEFAULT_STATUSES), 1000, now());
  });
  broadcast({ type: 'structure' });
  return db.prepare('SELECT * FROM spaces WHERE id = ?').get(id);
});
route('PATCH', '/api/spaces/:id', async ({ req, params }) => {
  const b = await readJson(req);
  const s = db.prepare('SELECT * FROM spaces WHERE id = ?').get(params.id) || notFound();
  const name = b.name !== undefined ? (str(b.name, 80) || bad('Nome vazio')) : s.name;
  const color = b.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : s.color;
  db.prepare('UPDATE spaces SET name = ?, color = ? WHERE id = ?').run(name, color, s.id);
  broadcast({ type: 'structure' });
  return { ok: true };
});
route('DELETE', '/api/spaces/:id', ({ params, user }) => {
  if (user.role !== 'admin') throw new HttpError(403, 'Apenas administradores podem excluir espaços');
  db.prepare('UPDATE spaces SET archived = 1 WHERE id = ?').run(params.id);
  db.prepare('UPDATE lists SET archived = 1 WHERE space_id = ?').run(params.id);
  broadcast({ type: 'structure' });
  return { ok: true };
});

// Pastas
route('POST', '/api/folders', async ({ req }) => {
  const b = await readJson(req);
  const space = db.prepare('SELECT * FROM spaces WHERE id = ? AND archived = 0').get(b.space_id) || notFound('Espaço não encontrado');
  const name = str(b.name, 80) || bad('Informe o nome da pasta');
  const id = uid();
  db.prepare('INSERT INTO folders (id, space_id, name, position, archived, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(id, space.id, name, nextPosition('folders', 'space_id = ?', space.id), now());
  broadcast({ type: 'structure' });
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
});
route('PATCH', '/api/folders/:id', async ({ req, params }) => {
  const b = await readJson(req);
  const f = db.prepare('SELECT * FROM folders WHERE id = ?').get(params.id) || notFound();
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(str(b.name, 80) || bad('Nome vazio'), f.id);
  broadcast({ type: 'structure' });
  return { ok: true };
});
// Excluir a pasta não apaga as listas: elas voltam para a raiz do espaço
route('DELETE', '/api/folders/:id', ({ params }) => {
  db.prepare('UPDATE lists SET folder_id = NULL WHERE folder_id = ?').run(params.id);
  db.prepare('UPDATE folders SET archived = 1 WHERE id = ?').run(params.id);
  broadcast({ type: 'structure' });
  return { ok: true };
});

function validFolder(folderId, spaceId) {
  if (!folderId) return null;
  const f = db.prepare('SELECT * FROM folders WHERE id = ? AND archived = 0').get(folderId) || notFound('Pasta não encontrada');
  if (f.space_id !== spaceId) bad('A pasta é de outro espaço');
  return f.id;
}

// Listas
route('POST', '/api/lists', async ({ req }) => {
  const b = await readJson(req);
  const space = db.prepare('SELECT * FROM spaces WHERE id = ? AND archived = 0').get(b.space_id) || notFound('Espaço não encontrado');
  const name = str(b.name, 80) || bad('Informe o nome da lista');
  const id = uid();
  db.prepare('INSERT INTO lists (id, space_id, folder_id, name, statuses, position, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
    .run(id, space.id, validFolder(b.folder_id, space.id), name, JSON.stringify(DEFAULT_STATUSES), nextPosition('lists', 'space_id = ?', space.id), now());
  broadcast({ type: 'structure' });
  return listRow(db.prepare('SELECT * FROM lists WHERE id = ?').get(id));
});
route('PATCH', '/api/lists/:id', async ({ req, params }) => {
  const b = await readJson(req);
  const l = db.prepare('SELECT * FROM lists WHERE id = ?').get(params.id) || notFound();
  const name = b.name !== undefined ? (str(b.name, 80) || bad('Nome vazio')) : l.name;
  let statuses = l.statuses;
  if (b.statuses !== undefined) {
    if (!Array.isArray(b.statuses) || !b.statuses.length || b.statuses.length > 20) bad('Status inválidos');
    const clean = b.statuses.map((s) => ({
      id: str(s.id, 40) || uid(), name: str(s.name, 40) || bad('Status sem nome'),
      color: /^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : '#70707d',
      type: ['open', 'active', 'done'].includes(s.type) ? s.type : 'active',
    }));
    if (!clean.some((s) => s.type === 'done')) bad('Mantenha pelo menos um status de conclusão');
    statuses = JSON.stringify(clean);
    // tarefas em status removidos voltam para o primeiro status
    const valid = new Set(clean.map((s) => s.id));
    for (const t of db.prepare('SELECT id, status FROM tasks WHERE list_id = ?').all(l.id)) {
      if (!valid.has(t.status)) db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(clean[0].id, t.id);
    }
  }
  const folder = b.folder_id !== undefined ? validFolder(b.folder_id, l.space_id) : l.folder_id;
  db.prepare('UPDATE lists SET name = ?, statuses = ?, folder_id = ? WHERE id = ?').run(name, statuses, folder, l.id);
  broadcast({ type: 'structure' });
  return listRow(db.prepare('SELECT * FROM lists WHERE id = ?').get(l.id));
});
route('DELETE', '/api/lists/:id', ({ params }) => {
  db.prepare('UPDATE lists SET archived = 1 WHERE id = ?').run(params.id);
  db.prepare('DELETE FROM favorites WHERE list_id = ?').run(params.id);
  broadcast({ type: 'structure' });
  return { ok: true };
});
route('POST', '/api/lists/:id/favorite', ({ params, user }) => {
  const exists = db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND list_id = ?').get(user.id, params.id);
  if (exists) db.prepare('DELETE FROM favorites WHERE user_id = ? AND list_id = ?').run(user.id, params.id);
  else db.prepare('INSERT INTO favorites (user_id, list_id) VALUES (?, ?)').run(user.id, params.id);
  return { favorite: !exists };
});

// Etiquetas
route('POST', '/api/tags', async ({ req }) => {
  const b = await readJson(req);
  const name = str(b.name, 30) || bad('Informe o nome da etiqueta');
  const existing = db.prepare('SELECT * FROM tags WHERE lower(name) = lower(?)').get(name);
  if (existing) return existing;
  const id = uid();
  db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)').run(id, name, /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  broadcast({ type: 'structure' });
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
});
route('DELETE', '/api/tags/:id', ({ params }) => {
  db.prepare('DELETE FROM task_tags WHERE tag_id = ?').run(params.id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(params.id);
  broadcast({ type: 'structure' });
  return { ok: true };
});

// Tarefas
route('GET', '/api/tasks', ({ url, user }) => {
  const q = url.searchParams;
  const where = ['t.archived = 0', 'l.archived = 0'];
  const args = [];
  if (q.get('list_id')) { where.push('t.list_id = ?'); args.push(q.get('list_id')); }
  if (q.get('space_id')) { where.push('l.space_id = ?'); args.push(q.get('space_id')); }
  if (q.get('folder_id')) { where.push('l.folder_id = ?'); args.push(q.get('folder_id')); }
  if (q.get('assignee') === 'me') { where.push('t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ?)'); args.push(user.id); }
  if (q.get('q')) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); args.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }
  if (q.get('top') === '1') where.push('t.parent_id IS NULL');
  if (q.get('open') === '1') where.push('t.completed_at IS NULL');
  const limit = Math.min(Number(q.get('limit')) || 2000, 5000);
  const rows = db.prepare(`SELECT t.* FROM tasks t JOIN lists l ON l.id = t.list_id WHERE ${where.join(' AND ')}
    ORDER BY t.position, t.created_at LIMIT ${limit}`).all(...args);
  return hydrateTasks(rows);
});

const PRIORITIES = [null, 'urgent', 'high', 'normal', 'low'];

route('POST', '/api/tasks', async ({ req, user }) => {
  const b = await readJson(req);
  const title = str(b.title, 300) || bad('Informe o título da tarefa');
  let listId = b.list_id;
  if (b.parent_id) {
    const parent = db.prepare('SELECT * FROM tasks WHERE id = ?').get(b.parent_id) || notFound('Tarefa pai não encontrada');
    listId = parent.list_id;
  }
  const list = db.prepare('SELECT * FROM lists WHERE id = ? AND archived = 0').get(listId) || notFound('Lista não encontrada');
  const statuses = JSON.parse(list.statuses);
  const status = statuses.find((s) => s.id === b.status)?.id || statuses[0].id;
  const done = statuses.find((s) => s.id === status).type === 'done';
  if (b.priority !== undefined && !PRIORITIES.includes(b.priority)) bad('Prioridade inválida');
  if (b.due_date !== undefined && !isDate(b.due_date)) bad('Data inválida');
  const id = uid();
  tx(() => {
    db.prepare(`INSERT INTO tasks (id, list_id, parent_id, title, description, status, priority, start_date, due_date, position,
      created_by, created_at, updated_at, completed_at, archived) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(id, list.id, b.parent_id || null, title, status, b.priority || null, b.start_date || null, b.due_date || null,
        nextPosition('tasks', 'list_id = ?', list.id), user.id, now(), now(), done ? now() : null);
    const assignees = Array.isArray(b.assignees) ? b.assignees : [];
    for (const a of assignees) db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(id, a);
    for (const tg of Array.isArray(b.tags) ? b.tags : []) db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(id, tg);
    watch(id, user.id);
    for (const a of assignees) watch(id, a);
    logActivity(id, user.id, 'created', {});
    notify(assignees, user.id, id, 'assigned', `atribuiu a você: ${title}`);
  });
  broadcast({ type: 'tasks', list_id: list.id, task_id: id });
  return getTask(id);
});

route('GET', '/api/tasks/:id', ({ params }) => taskDetail(params.id));

route('PATCH', '/api/tasks/:id', async ({ req, params, user }) => {
  const b = await readJson(req);
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) || notFound('Tarefa não encontrada');
  let list = db.prepare('SELECT * FROM lists WHERE id = ?').get(t.list_id);
  const sets = {};
  const changes = [];
  tx(() => {
    if (b.list_id !== undefined && b.list_id !== t.list_id) {
      const nl = db.prepare('SELECT * FROM lists WHERE id = ? AND archived = 0').get(b.list_id) || notFound('Lista não encontrada');
      const nst = JSON.parse(nl.statuses);
      sets.list_id = nl.id;
      if (!nst.some((s) => s.id === (b.status ?? t.status))) sets.status = nst[0].id;
      changes.push(['moved', { from: list.name, to: nl.name }]);
      db.prepare('UPDATE tasks SET list_id = ? WHERE parent_id = ?').run(nl.id, t.id);
      list = nl;
    }
    const statuses = JSON.parse(list.statuses);
    if (b.title !== undefined) {
      const title = str(b.title, 300) || bad('Título não pode ficar vazio');
      if (title !== t.title) { sets.title = title; changes.push(['title', { from: t.title, to: title }]); }
    }
    if (b.description !== undefined) {
      const d = typeof b.description === 'string' ? b.description.slice(0, 20000) : '';
      if (d !== t.description) { sets.description = d; changes.push(['description', {}]); }
    }
    if (b.status !== undefined && b.status !== t.status) {
      const s = statuses.find((x) => x.id === b.status) || bad('Status inválido');
      sets.status = s.id;
      const old = statuses.find((x) => x.id === t.status);
      changes.push(['status', { from: old?.name || t.status, to: s.name }]);
    }
    if (sets.status) {
      const done = statuses.find((x) => x.id === sets.status)?.type === 'done';
      // Avisos do ClickUp: concluir com subtarefas abertas ou esperando outra tarefa
      if (done && !t.completed_at && !b.force) {
        const openSubs = db.prepare('SELECT COUNT(*) n FROM tasks WHERE parent_id = ? AND archived = 0 AND completed_at IS NULL').get(t.id).n;
        const waiting = db.prepare(`SELECT COUNT(*) n FROM task_dependencies d JOIN tasks x ON x.id = d.depends_on
          WHERE d.task_id = ? AND x.archived = 0 AND x.completed_at IS NULL`).get(t.id).n;
        if (openSubs || waiting) {
          const e = new HttpError(409, waiting ? `Esta tarefa ainda espera ${waiting} tarefa${waiting > 1 ? 's' : ''} não concluída${waiting > 1 ? 's' : ''}` : `Ainda há ${openSubs} subtarefa${openSubs > 1 ? 's' : ''} aberta${openSubs > 1 ? 's' : ''}`);
          e.code = 'incomplete';
          throw e;
        }
      }
      sets.completed_at = done ? (t.completed_at || now()) : null;
    }
    if (b.priority !== undefined && b.priority !== t.priority) {
      if (!PRIORITIES.includes(b.priority)) bad('Prioridade inválida');
      sets.priority = b.priority; changes.push(['priority', { from: t.priority, to: b.priority }]);
    }
    for (const f of ['due_date', 'start_date']) {
      if (b[f] !== undefined && b[f] !== t[f]) {
        if (!isDate(b[f])) bad('Data inválida');
        sets[f] = b[f]; changes.push([f, { from: t[f], to: b[f] }]);
      }
    }
    if (b.position !== undefined && Number.isFinite(b.position)) sets.position = b.position;
    if (b.time_estimate !== undefined) {
      const m = b.time_estimate === null ? null : Math.round(Number(b.time_estimate));
      if (m !== null && (!Number.isFinite(m) || m < 0 || m > 100000)) bad('Estimativa inválida');
      if (m !== t.time_estimate) { sets.time_estimate = m; changes.push(['estimate', { to: m }]); }
    }
    if (b.archived !== undefined) { sets.archived = b.archived ? 1 : 0; changes.push([b.archived ? 'archived' : 'unarchived', {}]); }

    if (Object.keys(sets).length) {
      sets.updated_at = now();
      const cols = Object.keys(sets);
      db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => sets[c]), t.id);
    }
    if (Array.isArray(b.assignees)) {
      const before = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(t.id).map((r) => r.user_id);
      const valid = new Set(db.prepare('SELECT id FROM users').all().map((r) => r.id));
      const after = [...new Set(b.assignees)].filter((x) => valid.has(x));
      const added = after.filter((x) => !before.includes(x)), removed = before.filter((x) => !after.includes(x));
      for (const a of added) { db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(t.id, a); watch(t.id, a); }
      for (const r of removed) db.prepare('DELETE FROM task_assignees WHERE task_id = ? AND user_id = ?').run(t.id, r);
      if (added.length) changes.push(['assigned', { users: added }]);
      if (removed.length) changes.push(['unassigned', { users: removed }]);
      notify(added, user.id, t.id, 'assigned', `atribuiu a você: ${sets.title || t.title}`);
    }
    if (Array.isArray(b.tags)) {
      db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(t.id);
      for (const tg of new Set(b.tags)) db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) SELECT ?, id FROM tags WHERE id = ?').run(t.id, tg);
      changes.push(['tags', {}]);
    }
    for (const [type, data] of changes) if (type !== 'tags') logActivity(t.id, user.id, type, data);
    const statusChange = changes.find((c) => c[0] === 'status');
    if (statusChange && sets.completed_at && !t.completed_at) {
      for (const w of db.prepare('SELECT task_id FROM task_dependencies WHERE depends_on = ?').all(t.id)) {
        const wt = db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(w.task_id);
        if (wt) notify(db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(wt.id).map((r) => r.user_id), user.id, wt.id, 'unblocked',
          `concluiu "${sets.title || t.title}", liberando "${wt.title}"`);
      }
    }
    if (statusChange) notify(watchersOf(t.id), user.id, t.id, 'status', `mudou o status de "${sets.title || t.title}" para ${statusChange[1].to}`);
  });
  broadcast({ type: 'tasks', list_id: list.id, task_id: t.id });
  return getTask(t.id);
});

route('DELETE', '/api/tasks/:id', ({ params }) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) || notFound();
  const files = db.prepare('SELECT id FROM attachments WHERE task_id = ? OR task_id IN (SELECT id FROM tasks WHERE parent_id = ?)').all(t.id, t.id);
  tx(() => {
    const ids = [t.id, ...db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(t.id).map((r) => r.id)];
    for (const id of ids) {
      for (const tbl of ['task_assignees', 'task_tags', 'comments', 'checklist_items', 'activity', 'attachments', 'task_watchers', 'notifications', 'time_entries', 'task_dependencies'])
        db.prepare(`DELETE FROM ${tbl} WHERE task_id = ?`).run(id);
      db.prepare('DELETE FROM task_dependencies WHERE depends_on = ?').run(id);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    }
  });
  for (const f of files) fs.rm(path.join(UPLOAD_DIR, f.id), () => {});
  broadcast({ type: 'tasks', list_id: t.list_id, task_id: t.id, deleted: true });
  return { ok: true };
});

route('POST', '/api/tasks/:id/watch', ({ params, user }) => {
  const exists = db.prepare('SELECT 1 FROM task_watchers WHERE task_id = ? AND user_id = ?').get(params.id, user.id);
  if (exists) db.prepare('DELETE FROM task_watchers WHERE task_id = ? AND user_id = ?').run(params.id, user.id);
  else watch(params.id, user.id);
  return { watching: !exists };
});

// Comentários
route('POST', '/api/tasks/:id/comments', async ({ req, params, user }) => {
  const b = await readJson(req);
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) || notFound();
  const body = typeof b.body === 'string' ? b.body.trim().slice(0, 10000) : '';
  if (!body) bad('Comentário vazio');
  let attachmentId = null, px = null, py = null;
  if (b.attachment_id) {
    const a = db.prepare('SELECT * FROM attachments WHERE id = ? AND task_id = ?').get(b.attachment_id, t.id) || notFound('Anexo não encontrado');
    attachmentId = a.id;
    px = Math.min(1, Math.max(0, Number(b.x) || 0));
    py = Math.min(1, Math.max(0, Number(b.y) || 0));
  }
  const id = uid();
  db.prepare('INSERT INTO comments (id, task_id, user_id, body, created_at, attachment_id, pin_x, pin_y, resolved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)')
    .run(id, t.id, user.id, body, now(), attachmentId, px, py);
  const users = db.prepare('SELECT id, name FROM users WHERE active = 1').all();
  const mentioned = users.filter((u) => body.toLowerCase().includes('@' + u.name.toLowerCase().split(' ')[0])).map((u) => u.id);
  notify(mentioned, user.id, t.id, 'mention', `mencionou você em "${t.title}"`);
  notify(watchersOf(t.id).filter((u) => !mentioned.includes(u)), user.id, t.id, 'comment', `comentou em "${t.title}"`);
  watch(t.id, user.id);
  broadcast({ type: 'tasks', list_id: t.list_id, task_id: t.id });
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
});
route('PATCH', '/api/comments/:id', async ({ req, params, user }) => {
  const b = await readJson(req);
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(params.id) || notFound();
  if (b.resolved !== undefined && b.body === undefined) {
    db.prepare('UPDATE comments SET resolved = ? WHERE id = ?').run(b.resolved ? 1 : 0, c.id);
    if (b.resolved && c.attachment_id) logActivity(c.task_id, user.id, 'proof_resolved', {});
    broadcast({ type: 'tasks', task_id: c.task_id });
    return { ok: true };
  }
  if (c.user_id !== user.id) throw new HttpError(403, 'Você só pode editar seus comentários');
  const body = typeof b.body === 'string' ? b.body.trim().slice(0, 10000) : '';
  if (!body) bad('Comentário vazio');
  db.prepare('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').run(body, now(), c.id);
  broadcast({ type: 'tasks', task_id: c.task_id });
  return { ok: true };
});
route('DELETE', '/api/comments/:id', ({ params, user }) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(params.id) || notFound();
  if (c.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Você só pode excluir seus comentários');
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  broadcast({ type: 'tasks', task_id: c.task_id });
  return { ok: true };
});

// Checklist
route('POST', '/api/tasks/:id/checklist', async ({ req, params, user }) => {
  const b = await readJson(req);
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) || notFound();
  const text = str(b.text, 300) || bad('Item vazio');
  const id = uid();
  db.prepare('INSERT INTO checklist_items (id, task_id, text, done, position, created_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(id, t.id, text, nextPosition('checklist_items', 'task_id = ?', t.id), now());
  logActivity(t.id, user.id, 'checklist_add', { text });
  broadcast({ type: 'tasks', list_id: t.list_id, task_id: t.id });
  return db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id);
});
route('PATCH', '/api/checklist/:id', async ({ req, params }) => {
  const b = await readJson(req);
  const c = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(params.id) || notFound();
  const text = b.text !== undefined ? (str(b.text, 300) || bad('Item vazio')) : c.text;
  const done = b.done !== undefined ? (b.done ? 1 : 0) : c.done;
  db.prepare('UPDATE checklist_items SET text = ?, done = ? WHERE id = ?').run(text, done, c.id);
  broadcast({ type: 'tasks', task_id: c.task_id });
  return { ok: true };
});
route('DELETE', '/api/checklist/:id', ({ params }) => {
  const c = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(params.id) || notFound();
  db.prepare('DELETE FROM checklist_items WHERE id = ?').run(c.id);
  broadcast({ type: 'tasks', task_id: c.task_id });
  return { ok: true };
});

// Anexos
route('POST', '/api/tasks/:id/attachments', async ({ req, params, user }) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) || notFound();
  const filename = str(decodeURIComponent(req.headers['x-filename'] || 'arquivo'), 200).replace(/[\\/]/g, '_') || 'arquivo';
  const mime = str(req.headers['content-type'] || 'application/octet-stream', 100);
  const buf = await readBody(req, MAX_UPLOAD);
  if (!buf.length) bad('Arquivo vazio');
  const id = uid();
  fs.writeFileSync(path.join(UPLOAD_DIR, id), buf);
  db.prepare('INSERT INTO attachments (id, task_id, user_id, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, t.id, user.id, filename, mime, buf.length, now());
  logActivity(t.id, user.id, 'attachment', { filename });
  broadcast({ type: 'tasks', list_id: t.list_id, task_id: t.id });
  return { id, filename, mime, size: buf.length };
});
route('GET', '/api/attachments/:id', ({ params, res, url }) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(params.id) || notFound();
  const file = path.join(UPLOAD_DIR, a.id);
  if (!fs.existsSync(file)) notFound();
  const inline = url.searchParams.get('inline') === '1' && /^image\/(png|jpe?g|gif|webp)$/.test(a.mime);
  res.writeHead(200, {
    'Content-Type': inline ? a.mime : 'application/octet-stream',
    'Content-Length': a.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
  return undefined;
});
route('DELETE', '/api/attachments/:id', ({ params }) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(params.id) || notFound();
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  fs.rm(path.join(UPLOAD_DIR, a.id), () => {});
  broadcast({ type: 'tasks', task_id: a.task_id });
  return { ok: true };
});

// Controle de tempo
function stopRunning(userId) {
  const r = db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND ended_at IS NULL').get(userId);
  if (!r) return null;
  const end = now();
  const minutes = Math.max(1, Math.round((Date.parse(end) - Date.parse(r.started_at)) / 60000));
  db.prepare('UPDATE time_entries SET ended_at = ?, minutes = ? WHERE id = ?').run(end, minutes, r.id);
  return r.task_id;
}
route('POST', '/api/tasks/:id/timer', ({ params, user }) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) || notFound();
  const prev = stopRunning(user.id);
  db.prepare('INSERT INTO time_entries (id, task_id, user_id, started_at, ended_at, minutes, note, created_at) VALUES (?, ?, ?, ?, NULL, 0, \'\', ?)')
    .run(uid(), t.id, user.id, now(), now());
  broadcast({ type: 'tasks', list_id: t.list_id, task_id: t.id });
  if (prev && prev !== t.id) broadcast({ type: 'tasks', task_id: prev });
  return { ok: true };
});
route('POST', '/api/timer/stop', ({ user }) => {
  const taskId = stopRunning(user.id);
  if (taskId) broadcast({ type: 'tasks', task_id: taskId });
  return { ok: true, task_id: taskId };
});
route('POST', '/api/tasks/:id/time', async ({ req, params, user }) => {
  const b = await readJson(req);
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) || notFound();
  const minutes = Math.round(Number(b.minutes));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) bad('Informe um tempo entre 1 minuto e 24 horas');
  const day = isDate(b.date) && b.date ? b.date : now().slice(0, 10);
  const start = new Date(day + 'T12:00:00Z').toISOString();
  db.prepare('INSERT INTO time_entries (id, task_id, user_id, started_at, ended_at, minutes, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uid(), t.id, user.id, start, start, minutes, str(b.note, 200), now());
  broadcast({ type: 'tasks', list_id: t.list_id, task_id: t.id });
  return { ok: true };
});
route('DELETE', '/api/time/:id', ({ params, user }) => {
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(params.id) || notFound();
  if (e.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Você só pode apagar seus registros');
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(e.id);
  broadcast({ type: 'tasks', task_id: e.task_id });
  return { ok: true };
});
// Relatório de horas: registros concluídos num intervalo, para a visão de carga
route('GET', '/api/time', ({ url }) => {
  const from = url.searchParams.get('from') || '0000';
  const to = url.searchParams.get('to') || '9999';
  return db.prepare(`SELECT user_id, task_id, minutes, started_at FROM time_entries WHERE ended_at IS NOT NULL AND started_at >= ? AND started_at < ?`).all(from, to);
});

// Dependências: task_id espera depends_on
route('POST', '/api/tasks/:id/dependencies', async ({ req, params, user }) => {
  const b = await readJson(req);
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) || notFound();
  const other = db.prepare('SELECT * FROM tasks WHERE id = ?').get(b.depends_on) || notFound('Tarefa não encontrada');
  if (other.id === t.id) bad('Uma tarefa não pode depender dela mesma');
  // impede ciclo: other não pode (direta ou indiretamente) esperar t
  const seen = new Set();
  const stack = [other.id];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === t.id) bad('Isso criaria uma dependência circular');
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of db.prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ?').all(cur)) stack.push(r.depends_on);
  }
  db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on, created_at) VALUES (?, ?, ?)').run(t.id, other.id, now());
  logActivity(t.id, user.id, 'dependency', { title: other.title });
  broadcast({ type: 'tasks', list_id: t.list_id, task_id: t.id });
  return { ok: true };
});
route('DELETE', '/api/tasks/:id/dependencies/:other', ({ params }) => {
  db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on = ?').run(params.id, params.other);
  broadcast({ type: 'tasks', task_id: params.id });
  return { ok: true };
});

// Notificações
route('GET', '/api/notifications', ({ user }) => db.prepare(`SELECT n.*, t.title task_title FROM notifications n
  LEFT JOIN tasks t ON t.id = n.task_id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 200`).all(user.id));
route('POST', '/api/notifications/read', async ({ req, user }) => {
  const b = await readJson(req);
  if (b.id) db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(b.id, user.id);
  else db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(user.id);
  return { ok: true };
});

// Eventos
route('GET', '/api/events', ({ req, res }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
  return undefined;
});

// ---------- servidor ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=300' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    // Proteção CSRF simples: requisições que alteram dados precisam vir do próprio app
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'mk9') throw new HttpError(403, 'Requisição bloqueada');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const user = currentUser(req);
      if (r.auth && !user) throw new HttpError(401, 'Faça login para continuar');
      const out = await r.handler({ req, res, url, params, user });
      if (out !== undefined && !res.headersSent) send(res, 200, out);
      return;
    }
    throw new HttpError(404, 'Rota não encontrada');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Erro interno', code: e.code });
  }
});

server.listen(PORT, () => console.log(`MK9 Tarefas rodando em http://localhost:${PORT}`));
