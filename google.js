// Google Agenda: cada pessoa conecta a própria conta.
// - Tarefas com prazo atribuídas a ela viram eventos de dia inteiro na agenda principal dela.
// - Mudou a data ou o nome do evento no Google, a tarefa muda junto.
// - Os outros eventos da agenda aparecem no calendário da plataforma.
// Precisa de GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (Google Cloud > Credenciais > ID do cliente OAuth, tipo "Aplicativo da Web").
import crypto from 'node:crypto';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const REVOKE_URL = process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
const API = process.env.GOOGLE_API_URL || 'https://www.googleapis.com/calendar/v3';
const SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const SCOPES = ['openid', 'email', SCOPE_EVENTS].join(' ');
const CAL = 'primary';
const SYNC_EVERY = 10 * 60 * 1000;

const day = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);
const sha = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
const stripDone = (s) => String(s || '').replace(/^✓\s*/, '').trim();

export function setupGoogle({ db, route, broadcast, logActivity, now, HttpError, readJson, publicUrl }) {
  const configured = !!(CLIENT_ID && CLIENT_SECRET);
  let base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const states = new Map(); // state -> { userId, exp }
  const account = (userId) => db.prepare('SELECT * FROM google_accounts WHERE user_id = ?').get(userId);
  const redirectUri = () => `${base}/api/google/callback`;

  // ---------- chamadas ao Google ----------
  class Gone extends Error {}
  async function form(url, params) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    let data = {}; try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data };
  }
  function forget(userId, reason) {
    db.prepare('DELETE FROM google_events WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM google_accounts WHERE user_id = ?').run(userId);
    console.warn('Google desconectado de', userId, reason);
    broadcast({ type: 'google', users: [userId] });
  }
  async function accessToken(acc, force = false) {
    if (!force && acc.access_token && acc.expires_at > Date.now() + 60_000) return acc.access_token;
    const r = await form(TOKEN_URL, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: acc.refresh_token, grant_type: 'refresh_token' });
    if (!r.ok) {
      if (r.data?.error === 'invalid_grant') { forget(acc.user_id, 'acesso revogado'); throw new Gone(); }
      throw new Error(`token ${r.status} ${r.data?.error || ''}`);
    }
    acc.access_token = r.data.access_token;
    acc.expires_at = Date.now() + (r.data.expires_in || 3600) * 1000;
    db.prepare('UPDATE google_accounts SET access_token = ?, expires_at = ? WHERE user_id = ?').run(acc.access_token, acc.expires_at, acc.user_id);
    return acc.access_token;
  }
  async function gapi(acc, method, path, { body, query } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken(acc, attempt > 0);
      const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 401 && attempt === 0) continue;
      let data = null; if (r.status !== 204) { try { data = await r.json(); } catch {} }
      return { ok: r.ok, status: r.status, data };
    }
  }

  // Uma fila por pessoa, para nunca criar o mesmo evento duas vezes
  const queues = new Map();
  function enqueue(userId, fn) {
    const prev = queues.get(userId) || Promise.resolve();
    const next = prev.then(async () => {
      const acc = account(userId);
      if (!acc) return;
      try {
        await fn(acc);
        if (acc.last_error) db.prepare('UPDATE google_accounts SET last_error = NULL WHERE user_id = ?').run(userId);
      } catch (e) {
        if (e instanceof Gone) return;
        console.error('Google Agenda:', e.message);
        db.prepare('UPDATE google_accounts SET last_error = ? WHERE user_id = ?').run(String(e.message).slice(0, 300), userId);
      }
    });
    queues.set(userId, next);
    next.finally(() => { if (queues.get(userId) === next) queues.delete(userId); });
    return next;
  }

  // ---------- tarefas -> eventos ----------
  const TASK_SQL = `SELECT t.*, l.name list_name, l.statuses, s.name space_name FROM tasks t
    JOIN lists l ON l.id = t.list_id JOIN spaces s ON s.id = l.space_id
    JOIN task_assignees a ON a.task_id = t.id AND a.user_id = ?
    WHERE t.archived = 0 AND l.archived = 0 AND s.archived = 0 AND t.due_date IS NOT NULL
      AND (t.completed_at IS NULL OR t.due_date >= ?)`;
  const cutoff = () => day(today(), -60);
  const wantedTasks = (userId) => db.prepare(TASK_SQL + ' ORDER BY t.due_date LIMIT 2000').all(userId, cutoff());
  const wantedTask = (userId, taskId) => db.prepare(TASK_SQL + ' AND t.id = ?').get(userId, cutoff(), taskId);

  function eventFor(t) {
    const status = (JSON.parse(t.statuses).find((x) => x.id === t.status) || {}).name || t.status;
    const start = t.start_date && t.start_date <= t.due_date ? t.start_date : t.due_date;
    const link = `${base}/#/lista/${t.list_id}/lista?tarefa=${t.id}`;
    const ev = {
      summary: (t.completed_at ? '✓ ' : '') + t.title,
      description: `${t.space_name} › ${t.list_name}\nStatus: ${status}${t.description ? '\n\n' + t.description.slice(0, 3000) : ''}\n\nAbrir no MK9: ${link}`,
      start: { date: start }, end: { date: day(t.due_date, 1) },
      transparency: 'transparent', status: 'confirmed',
      extendedProperties: { private: { mk9Task: t.id } },
    };
    if (/^https?:\/\//.test(base)) ev.source = { title: 'MK9 Tarefas', url: link };
    if (t.completed_at) ev.colorId = '8';
    return { ev, start, due: t.due_date, title: t.title };
  }

  async function pushTask(acc, taskId) {
    const map = db.prepare('SELECT * FROM google_events WHERE task_id = ? AND user_id = ?').get(taskId, acc.user_id);
    const t = acc.sync_tasks ? wantedTask(acc.user_id, taskId) : null;
    if (!t) {
      if (!map) return;
      const r = await gapi(acc, 'DELETE', `/calendars/${CAL}/events/${encodeURIComponent(map.event_id)}`);
      if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`apagar evento ${r.status}`);
      db.prepare('DELETE FROM google_events WHERE task_id = ? AND user_id = ?').run(taskId, acc.user_id);
      return;
    }
    const { ev, start, due, title } = eventFor(t);
    const hash = sha(ev);
    if (map && map.pushed_hash === hash) return;
    let r = map ? await gapi(acc, 'PATCH', `/calendars/${CAL}/events/${encodeURIComponent(map.event_id)}`, { body: ev }) : null;
    if (!r || r.status === 404 || r.status === 410) r = await gapi(acc, 'POST', `/calendars/${CAL}/events`, { body: ev });
    if (!r.ok) throw new Error(`salvar evento ${r.status} ${r.data?.error?.message || ''}`);
    db.prepare(`INSERT INTO google_events (task_id, user_id, event_id, pushed_start, pushed_due, pushed_title, pushed_hash) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id, user_id) DO UPDATE SET event_id = excluded.event_id, pushed_start = excluded.pushed_start,
      pushed_due = excluded.pushed_due, pushed_title = excluded.pushed_title, pushed_hash = excluded.pushed_hash`)
      .run(taskId, acc.user_id, r.data.id, start, due, title, hash);
  }

  async function reconcile(acc) {
    const wanted = acc.sync_tasks ? wantedTasks(acc.user_id).map((t) => t.id) : [];
    const mapped = db.prepare('SELECT task_id FROM google_events WHERE user_id = ?').all(acc.user_id).map((r) => r.task_id);
    for (const id of new Set([...wanted, ...mapped])) await pushTask(acc, id);
  }

  // ---------- eventos -> tarefas, e a agenda para a plataforma ----------
  const evDate = (x) => x?.date || (x?.dateTime ? x.dateTime.slice(0, 10) : null);
  async function listEvents(acc, from, to) {
    const items = [];
    let pageToken;
    for (let page = 0; page < 8; page++) {
      const r = await gapi(acc, 'GET', `/calendars/${CAL}/events`, { query: {
        timeMin: `${from}T00:00:00Z`, timeMax: `${day(to, 1)}T23:59:59Z`, singleEvents: 'true', orderBy: 'startTime', maxResults: '250', pageToken,
      } });
      if (!r.ok) throw new Error(`ler agenda ${r.status} ${r.data?.error?.message || ''}`);
      items.push(...(r.data.items || []));
      pageToken = r.data.nextPageToken;
      if (!pageToken) break;
    }
    return items;
  }

  // Quem mexeu no Google ganha: data e nome do evento voltam para a tarefa
  function pullBack(acc, items) {
    for (const e of items) {
      const taskId = e.extendedProperties?.private?.mk9Task;
      if (!taskId || e.status === 'cancelled') continue;
      const map = db.prepare('SELECT * FROM google_events WHERE task_id = ? AND user_id = ? AND event_id = ?').get(taskId, acc.user_id, e.id);
      const t = map && db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (!t) continue;
      const gStart = evDate(e.start), gEndRaw = evDate(e.end);
      if (!gStart || !gEndRaw) continue;
      const gDue = e.end.date ? day(gEndRaw, -1) : gEndRaw;
      const gTitle = stripDone(e.summary);
      const sets = {}; const acts = [];
      if ((gStart !== map.pushed_start || gDue !== map.pushed_due) && gDue >= gStart) {
        if (gDue !== t.due_date) { sets.due_date = gDue; acts.push(['due_date', { from: t.due_date, to: gDue, via: 'google' }]); }
        const newStart = gStart < gDue ? gStart : null;
        if (newStart !== (t.start_date || null) && (newStart || t.start_date)) { sets.start_date = newStart; acts.push(['start_date', { from: t.start_date, to: newStart, via: 'google' }]); }
      }
      if (gTitle && gTitle !== map.pushed_title && gTitle !== t.title) { sets.title = gTitle.slice(0, 300); acts.push(['title', { from: t.title, to: sets.title, via: 'google' }]); }
      if (!acts.length) {
        if (gStart !== map.pushed_start || gDue !== map.pushed_due || gTitle !== map.pushed_title) {
          db.prepare('UPDATE google_events SET pushed_start = ?, pushed_due = ?, pushed_title = ?, pushed_hash = NULL WHERE task_id = ? AND user_id = ?').run(gStart, gDue, gTitle, taskId, acc.user_id);
        }
        continue;
      }
      sets.updated_at = now();
      const cols = Object.keys(sets);
      db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => sets[c]), taskId);
      for (const [type, data] of acts) logActivity(taskId, acc.user_id, type, data);
      // O que está no Google agora passa a ser o "último enviado"; o hash zera para o próximo envio corrigir descrição e afins
      db.prepare('UPDATE google_events SET pushed_start = ?, pushed_due = ?, pushed_title = ?, pushed_hash = NULL WHERE task_id = ? AND user_id = ?').run(gStart, gDue, gTitle, taskId, acc.user_id);
      broadcast({ type: 'tasks', list_id: t.list_id, task_id: taskId });
    }
  }

  async function fullSync(acc) {
    const items = await listEvents(acc, day(today(), -30), day(today(), 180));
    pullBack(acc, items);
    await reconcile(acc);
    db.prepare('UPDATE google_accounts SET last_sync = ? WHERE user_id = ?').run(now(), acc.user_id);
  }

  // ---------- reagir às mudanças da plataforma ----------
  const pendingTasks = new Set();
  let taskTimer = null, allTimer = null;
  function onEvent(event) {
    if (!configured) return;
    if (event.type === 'tasks' && event.task_id) {
      pendingTasks.add(event.task_id);
      clearTimeout(taskTimer);
      taskTimer = setTimeout(flushTasks, 1200);
    } else if (event.type === 'structure' || (event.type === 'tasks' && !event.task_id)) {
      clearTimeout(allTimer);
      allTimer = setTimeout(() => { for (const a of db.prepare('SELECT user_id FROM google_accounts').all()) enqueue(a.user_id, reconcile); }, 4000);
    }
  }
  function flushTasks() {
    const ids = [...pendingTasks]; pendingTasks.clear();
    const connected = new Set(db.prepare('SELECT user_id FROM google_accounts').all().map((r) => r.user_id));
    if (!connected.size) return;
    for (const id of ids) {
      const subs = db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(id).map((r) => r.id);
      for (const tid of [id, ...subs]) {
        const users = new Set([
          ...db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(tid).map((r) => r.user_id),
          ...db.prepare('SELECT user_id FROM google_events WHERE task_id = ?').all(tid).map((r) => r.user_id),
        ]);
        for (const u of users) if (connected.has(u)) enqueue(u, (acc) => pushTask(acc, tid));
      }
    }
  }
  if (configured) {
    setInterval(() => { for (const a of db.prepare('SELECT user_id FROM google_accounts').all()) enqueue(a.user_id, fullSync); }, SYNC_EVERY).unref();
  }

  // ---------- rotas ----------
  const status = (userId) => {
    const a = account(userId);
    return { configured, connected: !!a, email: a?.email || null, sync_tasks: !!a?.sync_tasks, last_sync: a?.last_sync || null, last_error: a?.last_error || null,
      events: a ? db.prepare('SELECT COUNT(*) n FROM google_events WHERE user_id = ?').get(userId).n : 0 };
  };
  const redirect = (res, to) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };
  const need = (cond, msg) => { if (!cond) throw new HttpError(400, msg); };

  route('GET', '/api/google', ({ user }) => status(user.id));

  route('GET', '/api/google/connect', ({ req, res, user }) => {
    need(configured, 'O Google Agenda ainda não foi configurado no servidor');
    if (!process.env.PUBLIC_URL) base = publicUrl(req);
    for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
    const state = crypto.randomBytes(18).toString('base64url');
    states.set(state, { userId: user.id, exp: Date.now() + 10 * 60_000 });
    const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    redirect(res, `${AUTH_URL}?${q}`);
  });

  route('GET', '/api/google/callback', async ({ url, res, user }) => {
    const back = (r) => redirect(res, `/#/perfil?google=${r}`);
    const st = states.get(url.searchParams.get('state') || '');
    states.delete(url.searchParams.get('state') || '');
    if (!user) return redirect(res, '/');
    if (!st || st.userId !== user.id || st.exp < Date.now()) return back('expirou');
    if (url.searchParams.get('error')) return back('cancelado');
    const r = await form(TOKEN_URL, { code: url.searchParams.get('code') || '', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
    if (!r.ok) { console.error('Google OAuth:', r.status, r.data?.error, r.data?.error_description); return back('erro'); }
    if (!String(r.data.scope || '').split(' ').includes(SCOPE_EVENTS)) return back('permissao');
    let email = null;
    try { email = JSON.parse(Buffer.from(String(r.data.id_token).split('.')[1], 'base64url').toString()).email || null; } catch {}
    const old = account(user.id);
    const refresh = r.data.refresh_token || old?.refresh_token;
    if (!refresh) return back('erro');
    if (old && old.email && email && old.email !== email) db.prepare('DELETE FROM google_events WHERE user_id = ?').run(user.id);
    db.prepare(`INSERT INTO google_accounts (user_id, email, access_token, refresh_token, expires_at, sync_tasks, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at, last_error = NULL`)
      .run(user.id, email, r.data.access_token, refresh, Date.now() + (r.data.expires_in || 3600) * 1000, now());
    enqueue(user.id, fullSync);
    back('conectado');
  }, { auth: false });

  route('PATCH', '/api/google', async ({ req, user }) => {
    const b = await readJson(req);
    need(account(user.id), 'Conecte o Google Agenda primeiro');
    if (typeof b.sync_tasks === 'boolean') {
      db.prepare('UPDATE google_accounts SET sync_tasks = ? WHERE user_id = ?').run(b.sync_tasks ? 1 : 0, user.id);
      await enqueue(user.id, reconcile);
    }
    return status(user.id);
  });

  route('POST', '/api/google/sync', async ({ user }) => {
    need(account(user.id), 'Conecte o Google Agenda primeiro');
    await enqueue(user.id, fullSync);
    return status(user.id);
  });

  route('DELETE', '/api/google', async ({ url, user }) => {
    const acc = account(user.id);
    if (!acc) return status(user.id);
    // Por padrão tira da agenda os eventos que a plataforma criou; ?manter=1 deixa lá
    if (url.searchParams.get('manter') !== '1') {
      await enqueue(user.id, async (a) => { a.sync_tasks = 0; db.prepare('UPDATE google_accounts SET sync_tasks = 0 WHERE user_id = ?').run(user.id); await reconcile(a); });
    }
    form(REVOKE_URL, { token: acc.refresh_token }).catch(() => {});
    db.prepare('DELETE FROM google_events WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM google_accounts WHERE user_id = ?').run(user.id);
    return status(user.id);
  });

  // Eventos da agenda da pessoa para mostrar no calendário (sem os que vieram das tarefas)
  route('GET', '/api/google/events', async ({ url, user }) => {
    const acc = account(user.id);
    if (!acc) return { connected: false, events: [] };
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    need(re.test(from || '') && re.test(to || '') && from <= to, 'Período inválido');
    let items = [];
    let error = null;
    await enqueue(user.id, async (a) => {
      try { items = await listEvents(a, from, to); pullBack(a, items); }
      catch (e) { error = 'Não foi possível ler sua agenda agora'; throw e; }
    });
    if (!account(user.id)) return { connected: false, events: [] };
    const events = items.filter((e) => e.status !== 'cancelled' && !e.extendedProperties?.private?.mk9Task).map((e) => {
      const allDay = !!e.start?.date;
      return { id: e.id, title: e.summary || '(sem título)', all_day: allDay, start: e.start?.date || e.start?.dateTime, end: e.end?.date || e.end?.dateTime,
        start_date: evDate(e.start), end_date: allDay ? day(evDate(e.end), -1) : evDate(e.end), link: e.htmlLink || null, location: e.location || null,
        description: (e.description || '').slice(0, 2000), meet: e.hangoutLink || null };
    });
    return { connected: true, events, error };
  });

  const note = (req) => { if (!process.env.PUBLIC_URL) base = publicUrl(req); };
  return { onEvent, note, configured };
}
