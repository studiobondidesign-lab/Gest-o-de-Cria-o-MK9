// Google Agenda: cada pessoa conecta a própria conta.
// - Todas as agendas da conta aparecem no calendário da plataforma, cada uma com sua cor (a pessoa escolhe quais).
// - Tarefas com prazo atribuídas a ela viram eventos de dia inteiro na agenda que ela escolher (padrão: a principal).
// - Mudou a data ou o nome do evento no Google, a tarefa muda junto.
// Velocidade: o que muda na plataforma chega ao Google em ~1 s. O que muda no Google chega por aviso do Google
// (webhook, em segundos) e, se o aviso falhar, por uma conferência a cada minuto. O calendário lê uma cópia local.
// Precisa de GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (Google Cloud > Clientes > "Aplicativo da Web").
import crypto from 'node:crypto';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const REVOKE_URL = process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
const API = process.env.GOOGLE_API_URL || 'https://www.googleapis.com/calendar/v3';
const SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const SCOPE_LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const SCOPES = ['openid', 'email', SCOPE_EVENTS, SCOPE_LIST].join(' ');
const POLL_EVERY = Number(process.env.GOOGLE_POLL_MS || 60_000);
const FULL_EVERY = 6 * 3600_000;
const LIST_EVERY = 30 * 60_000;
const PAST_DAYS = 45, FUTURE_DAYS = 400;

const day = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);
const sha = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
const stripDone = (s) => String(s || '').replace(/^✓\s*/, '').trim();
const enc = encodeURIComponent;

export function setupGoogle({ db, route, broadcast, logActivity, now, HttpError, readJson, publicUrl }) {
  const configured = !!(CLIENT_ID && CLIENT_SECRET);
  let base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const states = new Map(); // state -> { userId, exp }
  const account = (userId) => db.prepare('SELECT * FROM google_accounts WHERE user_id = ?').get(userId);
  const calendars = (userId) => db.prepare('SELECT * FROM google_calendars WHERE user_id = ? ORDER BY is_primary DESC, name').all(userId);
  const calRow = (userId, calId) => db.prepare('SELECT * FROM google_calendars WHERE user_id = ? AND cal_id = ?').get(userId, calId);
  const targetCal = (acc) => acc.target_cal || 'primary';
  const redirectUri = () => `${base}/api/google/callback`;

  // ---------- chamadas ao Google ----------
  class Gone extends Error {}
  async function form(url, params) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    let data = {}; try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data };
  }
  function wipe(userId) {
    for (const t of ['google_events', 'google_cache', 'google_calendars', 'google_accounts']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
  }
  function forget(userId, reason) {
    wipe(userId);
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
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
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

  // ---------- lista de agendas ----------
  async function refreshCalendars(acc) {
    const r = await gapi(acc, 'GET', '/users/me/calendarList', { query: { maxResults: '250', minAccessRole: 'reader' } });
    let items;
    if (r.ok) items = r.data.items || [];
    else if (r.status === 403) items = [{ id: 'primary', summary: acc.email || 'Agenda principal', primary: true, accessRole: 'owner', selected: true }]; // sem permissão de listar: só a principal
    else throw new Error(`listar agendas ${r.status}`);
    const known = new Map(calendars(acc.user_id).map((c) => [c.cal_id, c]));
    const seen = new Set();
    for (const c of items) {
      // A agenda principal tem o e-mail como id; guardamos como "primary" para combinar com o padrão
      const id = c.primary ? 'primary' : c.id;
      seen.add(id);
      const old = known.get(id);
      const sel = old ? old.selected : (c.primary || c.selected ? 1 : 0);
      db.prepare(`INSERT INTO google_calendars (user_id, cal_id, name, color, role, is_primary, selected) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, cal_id) DO UPDATE SET name = excluded.name, color = excluded.color, role = excluded.role, is_primary = excluded.is_primary`)
        .run(acc.user_id, id, c.summaryOverride || c.summary || id, c.backgroundColor || '#7d8ce0', c.accessRole || 'reader', c.primary ? 1 : 0, sel);
    }
    for (const [id, c] of known) if (!seen.has(id)) { await stopChannel(acc, c); dropCalendar(acc.user_id, id); }
    db.prepare('UPDATE google_accounts SET lists_at = ? WHERE user_id = ?').run(Date.now(), acc.user_id);
  }
  function dropCalendar(userId, calId) {
    db.prepare('DELETE FROM google_cache WHERE user_id = ? AND cal_id = ?').run(userId, calId);
    db.prepare('DELETE FROM google_calendars WHERE user_id = ? AND cal_id = ?').run(userId, calId);
  }
  // Agendas que precisamos acompanhar: as que a pessoa mostra + a que recebe os prazos
  const watched = (acc) => calendars(acc.user_id).filter((c) => c.selected || c.cal_id === targetCal(acc));

  // ---------- cópia local dos eventos ----------
  const evDate = (x) => x?.date || (x?.dateTime ? x.dateTime.slice(0, 10) : null);
  function cacheRow(e) {
    const s = evDate(e.start), eRaw = evDate(e.end);
    const end = e.end?.date ? day(eRaw, -1) : eRaw;
    return { start: s, end: end && end >= s ? end : s };
  }
  const cacheUpsert = db.prepare(`INSERT INTO google_cache (user_id, cal_id, event_id, start_date, end_date, data) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, cal_id, event_id) DO UPDATE SET start_date = excluded.start_date, end_date = excluded.end_date, data = excluded.data`);
  const cacheDel = db.prepare('DELETE FROM google_cache WHERE user_id = ? AND cal_id = ? AND event_id = ?');
  function slim(e) {
    return { id: e.id, summary: e.summary, start: e.start, end: e.end, status: e.status, htmlLink: e.htmlLink, location: e.location,
      description: (e.description || '').slice(0, 2000), hangoutLink: e.hangoutLink, mk9: e.extendedProperties?.private?.mk9Task || null };
  }

  async function listAll(acc, calId, query) {
    const items = [];
    let pageToken;
    for (let page = 0; page < 20; page++) {
      const r = await gapi(acc, 'GET', `/calendars/${enc(calId)}/events`, { query: { ...query, singleEvents: 'true', maxResults: '250', pageToken } });
      if (!r.ok) return { status: r.status, items };
      items.push(...(r.data.items || []));
      pageToken = r.data.nextPageToken;
      if (!pageToken) break;
    }
    return { status: 200, items };
  }

  // Leitura completa da janela (ao conectar e a cada 6 h)
  async function fullSync(acc, cal) {
    const started = new Date().toISOString();
    const { status, items } = await listAll(acc, cal.cal_id, { timeMin: `${day(today(), -PAST_DAYS)}T00:00:00Z`, timeMax: `${day(today(), FUTURE_DAYS)}T00:00:00Z` });
    if (status === 404) { dropCalendar(acc.user_id, cal.cal_id); return true; }
    if (status !== 200) throw new Error(`ler agenda ${status}`);
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM google_cache WHERE user_id = ? AND cal_id = ?').run(acc.user_id, cal.cal_id);
      for (const e of items) if (e.status !== 'cancelled') { const r = cacheRow(e); if (r.start) cacheUpsert.run(acc.user_id, cal.cal_id, e.id, r.start, r.end, JSON.stringify(slim(e))); }
      db.prepare('UPDATE google_calendars SET last_full = ?, last_check = ? WHERE user_id = ? AND cal_id = ?').run(Date.now(), started, acc.user_id, cal.cal_id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    pullBack(acc, items);
    return true;
  }

  // Só o que mudou desde a última conferência (rápido; roda a cada minuto e quando o Google avisa)
  async function quickSync(acc, cal) {
    if (!cal.last_full || !cal.last_check || Date.now() - cal.last_full > FULL_EVERY) return fullSync(acc, cal);
    const started = new Date().toISOString();
    const since = new Date(Date.parse(cal.last_check) - 120_000).toISOString();
    const { status, items } = await listAll(acc, cal.cal_id, { updatedMin: since, showDeleted: 'true' });
    if (status === 410) return fullSync(acc, cal);
    if (status === 404) { dropCalendar(acc.user_id, cal.cal_id); return true; }
    if (status !== 200) throw new Error(`ler agenda ${status}`);
    let changed = false;
    for (const e of items) {
      const prev = db.prepare('SELECT data FROM google_cache WHERE user_id = ? AND cal_id = ? AND event_id = ?').get(acc.user_id, cal.cal_id, e.id);
      if (e.status === 'cancelled') { if (prev) { cacheDel.run(acc.user_id, cal.cal_id, e.id); changed = true; } continue; }
      const r = cacheRow(e);
      if (!r.start) continue;
      const data = JSON.stringify(slim(e));
      if (prev?.data !== data) { cacheUpsert.run(acc.user_id, cal.cal_id, e.id, r.start, r.end, data); changed = true; }
    }
    db.prepare('UPDATE google_calendars SET last_check = ? WHERE user_id = ? AND cal_id = ?').run(started, acc.user_id, cal.cal_id);
    if (items.length) pullBack(acc, items);
    return changed;
  }

  async function syncCalendars(acc, only = null) {
    if (!acc.lists_at || Date.now() - acc.lists_at > LIST_EVERY) await refreshCalendars(acc);
    let changed = false;
    for (const cal of watched(acc)) {
      if (only && cal.cal_id !== only) continue;
      if (await quickSync(acc, calRow(acc.user_id, cal.cal_id))) changed = true;
    }
    await ensureChannels(acc);
    db.prepare('UPDATE google_accounts SET last_sync = ? WHERE user_id = ?').run(now(), acc.user_id);
    if (changed) broadcast({ type: 'google', users: [acc.user_id], events: true });
  }

  // ---------- avisos do Google (webhook) ----------
  const canWatch = () => /^https:\/\//.test(base);
  async function stopChannel(acc, cal) {
    if (!cal?.channel_id) return;
    await gapi(acc, 'POST', '/channels/stop', { body: { id: cal.channel_id, resourceId: cal.resource_id } }).catch(() => {});
    db.prepare('UPDATE google_calendars SET channel_id = NULL, channel_token = NULL, resource_id = NULL, channel_exp = NULL WHERE user_id = ? AND cal_id = ?').run(acc.user_id, cal.cal_id);
  }
  async function ensureChannels(acc) {
    if (!canWatch()) return;
    const want = new Set(watched(acc).map((c) => c.cal_id));
    for (const cal of calendars(acc.user_id)) {
      if (!want.has(cal.cal_id)) { if (cal.channel_id) await stopChannel(acc, cal); continue; }
      if (cal.channel_id && cal.channel_exp > Date.now() + 24 * 3600_000) continue;
      if (cal.channel_id) await stopChannel(acc, cal);
      const id = crypto.randomUUID(), token = crypto.randomBytes(18).toString('base64url');
      const r = await gapi(acc, 'POST', `/calendars/${enc(cal.cal_id)}/events/watch`, { body: { id, type: 'web_hook', address: `${base}/api/google/webhook`, token, params: { ttl: String(7 * 86400) } } });
      if (!r.ok) { console.warn('Google watch falhou', r.status, r.data?.error?.message || ''); continue; } // segue com a conferência por minuto
      db.prepare('UPDATE google_calendars SET channel_id = ?, channel_token = ?, resource_id = ?, channel_exp = ? WHERE user_id = ? AND cal_id = ?')
        .run(id, token, r.data.resourceId, Number(r.data.expiration) || Date.now() + 7 * 86400_000, acc.user_id, cal.cal_id);
    }
  }
  const pokeTimers = new Map();
  function poke(userId, calId) {
    const k = userId + '|' + calId;
    clearTimeout(pokeTimers.get(k));
    pokeTimers.set(k, setTimeout(() => { pokeTimers.delete(k); enqueue(userId, (acc) => syncCalendars(acc, calId)); }, 800));
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

  async function deleteEvent(acc, map) {
    const r = await gapi(acc, 'DELETE', `/calendars/${enc(map.cal_id || 'primary')}/events/${enc(map.event_id)}`);
    if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`apagar evento ${r.status}`);
    db.prepare('DELETE FROM google_cache WHERE user_id = ? AND cal_id = ? AND event_id = ?').run(acc.user_id, map.cal_id || 'primary', map.event_id);
  }

  async function pushTask(acc, taskId) {
    let map = db.prepare('SELECT * FROM google_events WHERE task_id = ? AND user_id = ?').get(taskId, acc.user_id);
    const t = acc.sync_tasks ? wantedTask(acc.user_id, taskId) : null;
    const cal = targetCal(acc);
    if (map && (!t || (map.cal_id || 'primary') !== cal)) {
      await deleteEvent(acc, map);
      db.prepare('DELETE FROM google_events WHERE task_id = ? AND user_id = ?').run(taskId, acc.user_id);
      map = null;
    }
    if (!t) return;
    const { ev, start, due, title } = eventFor(t);
    const hash = sha([cal, ev]);
    if (map && map.pushed_hash === hash) return;
    let r = map ? await gapi(acc, 'PATCH', `/calendars/${enc(cal)}/events/${enc(map.event_id)}`, { body: ev }) : null;
    if (!r || r.status === 404 || r.status === 410) r = await gapi(acc, 'POST', `/calendars/${enc(cal)}/events`, { body: ev });
    if (!r.ok) throw new Error(`salvar evento ${r.status} ${r.data?.error?.message || ''}`);
    db.prepare(`INSERT INTO google_events (task_id, user_id, event_id, cal_id, pushed_start, pushed_due, pushed_title, pushed_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id, user_id) DO UPDATE SET event_id = excluded.event_id, cal_id = excluded.cal_id, pushed_start = excluded.pushed_start,
      pushed_due = excluded.pushed_due, pushed_title = excluded.pushed_title, pushed_hash = excluded.pushed_hash`)
      .run(taskId, acc.user_id, r.data.id, cal, start, due, title, hash);
    const row = cacheRow(r.data);
    if (row.start) cacheUpsert.run(acc.user_id, cal, r.data.id, row.start, row.end, JSON.stringify(slim(r.data)));
  }

  async function reconcile(acc) {
    const wanted = acc.sync_tasks ? wantedTasks(acc.user_id).map((t) => t.id) : [];
    const mapped = db.prepare('SELECT task_id FROM google_events WHERE user_id = ?').all(acc.user_id).map((r) => r.task_id);
    for (const id of new Set([...wanted, ...mapped])) await pushTask(acc, id);
    db.prepare('UPDATE google_accounts SET reconciled_at = ? WHERE user_id = ?').run(Date.now(), acc.user_id);
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
      const remember = () => db.prepare('UPDATE google_events SET pushed_start = ?, pushed_due = ?, pushed_title = ?, pushed_hash = NULL WHERE task_id = ? AND user_id = ?').run(gStart, gDue, gTitle, taskId, acc.user_id);
      if (!acts.length) {
        if (gStart !== map.pushed_start || gDue !== map.pushed_due || gTitle !== map.pushed_title) remember();
        continue;
      }
      sets.updated_at = now();
      const cols = Object.keys(sets);
      db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => sets[c]), taskId);
      for (const [type, data] of acts) logActivity(taskId, acc.user_id, type, data);
      remember();
      broadcast({ type: 'tasks', list_id: t.list_id, task_id: taskId });
    }
  }

  async function fullCycle(acc) {
    await syncCalendars(acc);
    if (!acc.reconciled_at || Date.now() - acc.reconciled_at > 30 * 60_000) await reconcile(account(acc.user_id) || acc);
  }

  // ---------- reagir às mudanças da plataforma ----------
  const pendingTasks = new Set();
  let taskTimer = null, allTimer = null;
  function onEvent(event) {
    if (!configured) return;
    if (event.type === 'tasks' && event.task_id) {
      pendingTasks.add(event.task_id);
      clearTimeout(taskTimer);
      taskTimer = setTimeout(flushTasks, 600);
    } else if (event.type === 'structure' || (event.type === 'tasks' && !event.task_id)) {
      clearTimeout(allTimer);
      allTimer = setTimeout(() => { for (const a of db.prepare('SELECT user_id FROM google_accounts').all()) enqueue(a.user_id, reconcile); }, 3000);
    }
  }
  function flushTasks() {
    const ids = [...pendingTasks]; pendingTasks.clear();
    const connected = new Set(db.prepare('SELECT user_id FROM google_accounts').all().map((r) => r.user_id));
    if (!connected.size) return;
    const touched = new Set();
    for (const id of ids) {
      const subs = db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(id).map((r) => r.id);
      for (const tid of [id, ...subs]) {
        const users = new Set([
          ...db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(tid).map((r) => r.user_id),
          ...db.prepare('SELECT user_id FROM google_events WHERE task_id = ?').all(tid).map((r) => r.user_id),
        ]);
        for (const u of users) if (connected.has(u)) { enqueue(u, (acc) => pushTask(acc, tid)); touched.add(u); }
      }
    }
    // O calendário de quem tem a agenda conectada lê a cópia local: avisa para ele se atualizar
    for (const u of touched) enqueue(u, async () => broadcast({ type: 'google', users: [u], events: true }));
  }
  if (configured) {
    setInterval(() => { for (const a of db.prepare('SELECT user_id FROM google_accounts').all()) enqueue(a.user_id, fullCycle); }, POLL_EVERY).unref();
  }

  // ---------- rotas ----------
  const status = (userId) => {
    const a = account(userId);
    return { configured, connected: !!a, email: a?.email || null, sync_tasks: !!a?.sync_tasks, last_sync: a?.last_sync || null, last_error: a?.last_error || null,
      instant: !!a && canWatch() && calendars(userId).some((c) => c.channel_id),
      events: a ? db.prepare('SELECT COUNT(*) n FROM google_events WHERE user_id = ?').get(userId).n : 0,
      target_cal: a ? targetCal(a) : null,
      calendars: a ? calendars(userId).map((c) => ({ id: c.cal_id, name: c.name, color: c.color, primary: !!c.is_primary, selected: !!c.selected,
        writable: c.role === 'owner' || c.role === 'writer' })) : [] };
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
    if (old && old.email && email && old.email !== email) wipe(user.id); // outra conta Google: começa do zero
    db.prepare(`INSERT INTO google_accounts (user_id, email, access_token, refresh_token, expires_at, sync_tasks, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at, last_error = NULL, lists_at = NULL, reconciled_at = NULL`)
      .run(user.id, email, r.data.access_token, refresh, Date.now() + (r.data.expires_in || 3600) * 1000, now());
    enqueue(user.id, fullCycle);
    back('conectado');
  }, { auth: false });

  route('PATCH', '/api/google', async ({ req, user }) => {
    const b = await readJson(req);
    const acc = account(user.id);
    need(acc, 'Conecte o Google Agenda primeiro');
    if (b.calendars && typeof b.calendars === 'object') {
      for (const [id, on] of Object.entries(b.calendars)) db.prepare('UPDATE google_calendars SET selected = ? WHERE user_id = ? AND cal_id = ?').run(on ? 1 : 0, user.id, id);
    }
    if (typeof b.target_cal === 'string') {
      const c = calRow(user.id, b.target_cal);
      need(c && (c.role === 'owner' || c.role === 'writer'), 'Escolha uma agenda em que você pode criar eventos');
      db.prepare('UPDATE google_accounts SET target_cal = ? WHERE user_id = ?').run(b.target_cal, user.id);
    }
    if (typeof b.sync_tasks === 'boolean') db.prepare('UPDATE google_accounts SET sync_tasks = ? WHERE user_id = ?').run(b.sync_tasks ? 1 : 0, user.id);
    if (typeof b.sync_tasks === 'boolean' || typeof b.target_cal === 'string') await enqueue(user.id, reconcile);
    if (b.calendars) await enqueue(user.id, (a) => syncCalendars(a));
    return status(user.id);
  });

  route('POST', '/api/google/sync', async ({ user }) => {
    need(account(user.id), 'Conecte o Google Agenda primeiro');
    db.prepare('UPDATE google_accounts SET lists_at = NULL, reconciled_at = NULL WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE google_calendars SET last_full = NULL WHERE user_id = ?').run(user.id);
    await enqueue(user.id, fullCycle);
    return status(user.id);
  });

  route('DELETE', '/api/google', async ({ url, user }) => {
    const acc = account(user.id);
    if (!acc) return status(user.id);
    await enqueue(user.id, async (a) => {
      for (const c of calendars(user.id)) await stopChannel(a, c);
      // Por padrão tira da agenda os eventos que a plataforma criou; ?manter=1 deixa lá
      if (url.searchParams.get('manter') !== '1') { a.sync_tasks = 0; db.prepare('UPDATE google_accounts SET sync_tasks = 0 WHERE user_id = ?').run(user.id); await reconcile(a); }
    });
    form(REVOKE_URL, { token: acc.refresh_token }).catch(() => {});
    wipe(user.id);
    return status(user.id);
  });

  // O Google avisa que algo mudou numa agenda; conferimos o token do canal e buscamos só o que mudou
  route('POST', '/api/google/webhook', ({ req, res }) => {
    const id = String(req.headers['x-goog-channel-id'] || '');
    const token = String(req.headers['x-goog-channel-token'] || '');
    const cal = id && db.prepare('SELECT * FROM google_calendars WHERE channel_id = ?').get(id);
    res.writeHead(cal && cal.channel_token === token ? 200 : 404); res.end();
    req.resume();
    if (cal && cal.channel_token === token && req.headers['x-goog-resource-state'] !== 'sync') poke(cal.user_id, cal.cal_id);
    return undefined;
  }, { auth: false });

  // Eventos das agendas escolhidas, lidos da cópia local (sem os que vieram das tarefas)
  route('GET', '/api/google/events', async ({ url, user }) => {
    const acc = account(user.id);
    if (!acc) return { connected: false, events: [] };
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    need(re.test(from || '') && re.test(to || '') && from <= to, 'Período inválido');
    // Primeira vez (ou agenda recém-ligada): espera a leitura inicial
    if (!calendars(user.id).length || watched(acc).some((c) => !c.last_full)) await enqueue(user.id, (a) => syncCalendars(a));
    if (!account(user.id)) return { connected: false, events: [] };
    const cals = new Map(calendars(user.id).filter((c) => c.selected).map((c) => [c.cal_id, c]));
    const rows = db.prepare('SELECT cal_id, data FROM google_cache WHERE user_id = ? AND start_date <= ? AND end_date >= ? ORDER BY start_date').all(user.id, to, from);
    const events = [];
    for (const r of rows) {
      const cal = cals.get(r.cal_id);
      if (!cal) continue;
      const e = JSON.parse(r.data);
      if (e.mk9) continue;
      const allDay = !!e.start?.date;
      events.push({ id: `${r.cal_id}|${e.id}`, title: e.summary || '(sem título)', all_day: allDay, start: e.start?.date || e.start?.dateTime, end: e.end?.date || e.end?.dateTime,
        start_date: evDate(e.start), end_date: allDay ? day(evDate(e.end), -1) : evDate(e.end), link: e.htmlLink || null, location: e.location || null,
        description: e.description || '', meet: e.hangoutLink || null, color: cal.color, calendar: cal.name });
    }
    return { connected: true, events, error: acc.last_error ? 'Não foi possível ler sua agenda agora' : null };
  });

  const note = (req) => { if (!process.env.PUBLIC_URL) base = publicUrl(req); };
  return { onEvent, note, configured };
}
