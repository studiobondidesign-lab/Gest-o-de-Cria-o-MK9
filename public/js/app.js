import {
  esc, icon, PRIORITY, MONTHS_FULL, ymd, today, addDays, fmtDate, dateClass, timeAgo, fmtSize,
  api, setUnauthorizedHandler, toast, fail, openPopover, closePopover, menuPopover, popoverOpen, dialog, confirmDialog, autosize,
} from './ui.js';
import { openTask, closeTask, refreshTask, currentTaskId, taskIsBusy } from './task.js';

// ---------- estado ----------
export const S = {
  me: null, users: [], spaces: [], folders: [], lists: [], tags: [], unread: 0, favorites: [], timer: null,
  route: { name: 'inicio' }, tasks: [], loadingTasks: false, selected: new Set(), timeLog: [],
  filters: { q: '', assignees: [], priorities: [], showDone: true, sort: 'manual', group: 'status' },
  tlStart: null,
  calMonth: (() => { const d = new Date(); d.setDate(1); return d; })(),
  config: {},
};
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('mk9:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mk9:' + k, JSON.stringify(v)); } catch { /* sem storage */ } },
};
const collapsedSpaces = new Set(store.get('collapsedSpaces', []));
const collapsedGroups = new Set();

export const userById = (id) => S.users.find((u) => u.id === id);
export const listById = (id) => S.lists.find((l) => l.id === id);
export const spaceById = (id) => S.spaces.find((s) => s.id === id);
export const tagById = (id) => S.tags.find((t) => t.id === id);
export const folderById = (id) => S.folders.find((f) => f.id === id);
// Rotas que mostram tarefas com as visões Lista / Quadro / Calendário / Linha do tempo
const TASK_ROUTES = ['lista', 'espaco', 'pasta', 'minhas'];
export function fmtMinutes(m) {
  m = Math.round(m || 0);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}min` : `${h}h`;
}
export function parseDuration(text) {
  // aceita "1h30", "1h 30min", "90", "90m", "1,5h"
  const t = String(text || '').toLowerCase().replace(',', '.').trim();
  if (!t) return null;
  const hm = t.match(/^(\d+(?:\.\d+)?)\s*h\s*(?:(\d+)\s*(?:m|min)?)?$/);
  if (hm) return Math.round(parseFloat(hm[1]) * 60 + (hm[2] ? parseInt(hm[2], 10) : 0));
  const m = t.match(/^(\d+)\s*(?:m|min)?$/);
  return m ? parseInt(m[1], 10) : NaN;
}
export const statusOf = (task) => listById(task.list_id)?.statuses.find((s) => s.id === task.status) || { id: task.status, name: task.status, color: '#70707d', type: 'open' };
export const isDone = (task) => statusOf(task).type === 'done';

export const initials = (name = '?') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
export const avatar = (u, size = '') => u ? `<span class="avatar ${size}" style="background:${esc(u.color)}" title="${esc(u.name)}">${esc(initials(u.name))}</span>` : '';
export const avatars = (ids, max = 3) => {
  const us = ids.map(userById).filter(Boolean);
  if (!us.length) return `<span class="avatar-empty">${icon('user', 'sm')}</span>`;
  const extra = us.length > max ? `<span class="avatar" style="background:var(--surface-3);color:var(--text)">+${us.length - max}</span>` : '';
  return `<span class="avatars">${us.slice(0, max).map((u) => avatar(u)).join('')}${extra}</span>`;
};
export const statusPill = (st, tag = 'span', attrs = '', cls = '') => `<${tag} class="status-pill ${cls}" style="--c:${esc(st.color)}" ${attrs}><span class="dot"></span>${esc(st.name)}</${tag}>`;
export const prioHtml = (p, withLabel = true) => p
  ? `<span class="prio" style="--p:${PRIORITY[p].color}">${icon('flag', 'sm')}${withLabel ? PRIORITY[p].label : ''}</span>`
  : `<span class="prio faint">${icon('flag', 'sm')}${withLabel ? '—' : ''}</span>`;
export const tagHtml = (t, removable = false) => t ? `<span class="tag" style="--c:${esc(t.color)}">${esc(t.name)}${removable ? `<button data-remove-tag="${esc(t.id)}" aria-label="Remover etiqueta">${icon('x', 'sm')}</button>` : ''}</span>` : '';
export const dateHtml = (task) => task.due_date ? `<span class="date ${dateClass(task.due_date, isDone(task))}">${icon('calendar', 'sm')}${fmtDate(task.due_date)}</span>` : '';

// ---------- dados ----------
export async function loadBootstrap() {
  const b = await api('GET', '/api/bootstrap');
  Object.assign(S, { me: b.me, users: b.users, spaces: b.spaces, folders: b.folders || [], lists: b.lists, tags: b.tags, unread: b.unread, favorites: b.favorites, timer: b.timer });
}

function tasksQuery() {
  const r = S.route;
  if (r.name === 'lista') return `list_id=${encodeURIComponent(r.id)}`;
  if (r.name === 'espaco') return `space_id=${encodeURIComponent(r.id)}`;
  if (r.name === 'pasta') return `folder_id=${encodeURIComponent(r.id)}`;
  if (r.name === 'minhas') return 'assignee=me';
  if (r.name === 'inicio' || r.name === 'carga') return '';
  return null;
}
let tasksSeq = 0;
export async function loadTasks() {
  const q = tasksQuery();
  if (q === null) { S.tasks = []; return; }
  const seq = ++tasksSeq;
  const [rows, log] = await Promise.all([
    api('GET', '/api/tasks?' + q),
    S.route.name === 'carga' ? api('GET', '/api/time?from=' + encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())) : null,
  ]);
  if (seq !== tasksSeq) return;
  S.tasks = rows;
  if (log) S.timeLog = log;
}

// Atualiza uma tarefa localmente (otimista) e no servidor.
export async function patchTask(id, patch, { silent = false } = {}) {
  const t = S.tasks.find((x) => x.id === id);
  const before = t ? { ...t } : null;
  if (t) { Object.assign(t, patch); renderContent(); }
  try {
    const updated = await api('PATCH', `/api/tasks/${id}`, patch);
    const i = S.tasks.findIndex((x) => x.id === id);
    if (i >= 0) S.tasks[i] = updated;
    renderContent();
    if (currentTaskId() === id || currentTaskId() === updated.parent_id) refreshTask();
    return updated;
  } catch (e) {
    if (t && before) { Object.assign(t, before); renderContent(); }
    // Aviso de tarefa incompleta (subtarefas abertas ou esperando outra tarefa): confirma e conclui mesmo assim
    if (e.code === 'incomplete' && !patch.force) {
      if (await confirmDialog('Concluir mesmo assim?', e.message + '.', { ok: 'Concluir assim mesmo' })) return patchTask(id, { ...patch, force: true }, { silent });
      throw e;
    }
    if (!silent) fail(e);
    throw e;
  }
}

export async function createTask(data) {
  const t = await api('POST', '/api/tasks', data);
  if (!S.tasks.some((x) => x.id === t.id) && tasksQuery() !== null) {
    const r = S.route;
    const belongs = r.name === 'inicio' || (r.name === 'lista' && t.list_id === r.id)
      || (r.name === 'espaco' && listById(t.list_id)?.space_id === r.id) || (r.name === 'pasta' && listById(t.list_id)?.folder_id === r.id)
      || (r.name === 'minhas' && t.assignees.includes(S.me.id)) || r.name === 'carga';
    if (belongs) S.tasks.push(t);
  }
  renderContent();
  renderSidebar();
  return t;
}

export function doneStatusFor(task) {
  const l = listById(task.list_id);
  return l?.statuses.find((s) => s.type === 'done')?.id;
}
export function openStatusFor(task) {
  const l = listById(task.list_id);
  return (l?.statuses.find((s) => s.type === 'open') || l?.statuses[0])?.id;
}
export function toggleDone(task) {
  return patchTask(task.id, { status: isDone(task) ? openStatusFor(task) : doneStatusFor(task) });
}

// ---------- popovers de campos ----------
export function pickStatus(anchor, task, onDone) {
  const l = listById(task.list_id);
  menuPopover(anchor, {
    items: () => l.statuses.map((s) => ({ id: s.id, text: s.name, selected: s.id === task.status, html: statusPill(s) })),
    onPick: async (id) => { if (id !== task.status) { await (onDone ? onDone({ status: id }) : patchTask(task.id, { status: id })); } },
  });
}
export function pickPriority(anchor, task, onDone) {
  menuPopover(anchor, {
    items: () => [...Object.entries(PRIORITY).map(([k, p]) => ({ id: k, text: p.label, selected: task.priority === k, html: prioHtml(k) })),
      { sep: true }, { id: '', text: 'limpar', html: '<span class="muted">Sem prioridade</span>' }],
    onPick: async (id) => { const p = id || null; if (p !== task.priority) await (onDone ? onDone({ priority: p }) : patchTask(task.id, { priority: p })); },
  });
}
export function pickAssignees(anchor, task, onDone) {
  let sel = [...task.assignees];
  menuPopover(anchor, {
    search: true, multi: true, width: 260,
    items: () => S.users.filter((u) => u.active).map((u) => ({ id: u.id, text: u.name + ' ' + u.email, selected: sel.includes(u.id),
      html: `${avatar(u)}<span class="ellipsis">${esc(u.name)}${u.id === S.me.id ? ' <span class="faint">(você)</span>' : ''}</span>` })),
    onPick: async (id) => {
      sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
      task.assignees = sel;
      await (onDone ? onDone({ assignees: sel }) : patchTask(task.id, { assignees: sel }));
    },
  });
}
export function pickTags(anchor, task, onDone) {
  let sel = [...task.tags];
  menuPopover(anchor, {
    search: true, multi: true, width: 260,
    items: () => S.tags.map((t) => ({ id: t.id, text: t.name, selected: sel.includes(t.id), html: tagHtml(t) })),
    footer: (q) => q && !S.tags.some((t) => t.name.toLowerCase() === q) ? `<div class="menu-sep"></div><button class="menu-item" data-create="1">${icon('plus', 'sm')} Criar etiqueta “${esc(q)}”</button>` : '',
    onPick: async (id, el, q) => {
      if (el.dataset.create) {
        const t = await api('POST', '/api/tags', { name: q });
        if (!S.tags.some((x) => x.id === t.id)) S.tags.push(t);
        id = t.id;
        const inp = el.closest('.popover').querySelector('.pop-search input');
        if (inp) inp.value = '';
      }
      sel = sel.includes(id) && !el.dataset.create ? sel.filter((x) => x !== id) : [...new Set([...sel, id])];
      task.tags = sel;
      await (onDone ? onDone({ tags: sel }) : patchTask(task.id, { tags: sel }));
    },
  });
}

// ---------- roteamento ----------
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  const name = parts[0] || 'inicio';
  return { name, id: parts[1], view: parts[2] || store.get('view:' + parts[1], 'lista'), task: params.get('tarefa') };
}
export function go(hash) { location.hash = hash; }
export function routeHash(r = S.route) {
  if (r.name === 'lista' || r.name === 'espaco' || r.name === 'pasta') return `#/${r.name}/${r.id}/${r.view}`;
  if (r.name === 'minhas') return `#/minhas/_/${r.view}`;
  return `#/${r.name}`;
}
export function taskHash(id) { return routeHash() + '?tarefa=' + id; }

async function onRoute() {
  const r = parseHash();
  const prev = S.route;
  const changed = prev.name !== r.name || prev.id !== r.id || prev.view !== r.view;
  S.route = r;
  if (r.id && TASK_ROUTES.includes(r.name)) store.set('view:' + r.id, r.view);
  if (changed || !S.shellRendered) {
    S.filters.q = '';
    S.filters.group = store.get('group:' + (r.id || r.name), 'status');
    S.selected.clear();
    renderShell();
    S.loadingTasks = true;
    renderContent();
    try { await loadTasks(); } catch (e) { fail(e); }
    S.loadingTasks = false;
    renderContent();
  }
  if (r.task && r.task !== currentTaskId()) openTask(r.task);
  else if (!r.task && currentTaskId()) closeTask(false);
  document.querySelector('.app')?.classList.remove('nav-open');
}

// ---------- autenticação ----------
function renderAuth(mode = 'login') {
  const root = document.getElementById('root');
  const reg = mode === 'register';
  root.innerHTML = `
  <div class="auth">
    <section class="auth-hero">
      <span class="brand"><span class="brand-mark">MK9</span>Criação</span>
      <div>
        <h1>Tudo que a Criação produz, num só lugar.</h1>
        <p>Briefings, peças, revisões e aprovações organizados em espaços, listas e quadros, com a equipe inteira vendo o mesmo andamento.</p>
      </div>
      <span class="caption faint">MK9 · uso interno</span>
    </section>
    <section class="auth-panel">
      <div class="auth-card">
        <div class="auth-switch" role="tablist">
          <button class="${reg ? '' : 'on'}" data-mode="login" role="tab">Entrar</button>
          <button class="${reg ? 'on' : ''}" data-mode="register" role="tab">Criar conta</button>
        </div>
        <div>
          <h2 class="h-display" style="font-size:var(--text-heading-sm)">${reg ? 'Crie sua conta' : 'Bem-vindo de volta'}</h2>
          <p class="muted" style="margin:8px 0 0">${reg ? 'Leva menos de um minuto.' : 'Entre com seu e-mail e senha.'}</p>
        </div>
        <form novalidate>
          ${reg ? `<div class="field"><label for="f-name">Nome</label><input class="input" id="f-name" name="name" autocomplete="name" required></div>` : ''}
          <div class="field"><label for="f-email">E-mail</label><input class="input" id="f-email" name="email" type="email" autocomplete="email" required
            placeholder="${S.config.emailDomain ? 'voce@' + esc(S.config.emailDomain) : 'voce@mk9.com.br'}"></div>
          <div class="field"><label for="f-pass">Senha</label><input class="input" id="f-pass" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="8" ${reg ? 'placeholder="Mínimo de 8 caracteres"' : ''}></div>
          ${reg && S.config.registrationCode ? `<div class="field"><label for="f-code">Código de convite</label><input class="input" id="f-code" name="code" required></div>` : ''}
          <div class="form-error" role="alert"></div>
          <button class="btn btn-primary btn-block" type="submit">${reg ? 'Criar conta' : 'Entrar'}</button>
        </form>
      </div>
    </section>
  </div>`;
  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => renderAuth(b.dataset.mode)));
  const form = root.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const err = form.querySelector('.form-error');
    const btn = form.querySelector('button[type=submit]');
    err.textContent = '';
    btn.disabled = true;
    try {
      await api('POST', reg ? '/api/auth/register' : '/api/auth/login', data, { quiet401: true });
      await boot();
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  });
  root.querySelector('input')?.focus();
}

// ---------- shell ----------
function renderShell() {
  const root = document.getElementById('root');
  if (!root.querySelector('.app')) {
    root.innerHTML = `<div class="app"><aside class="sidebar" aria-label="Navegação"></aside><main class="main"><div class="topbar"></div><div class="toolbar-slot"></div><div class="content" tabindex="-1"></div></main></div>`;
  }
  S.shellRendered = true;
  renderSidebar();
  renderTop();
}

export function renderSidebar() {
  const el = document.querySelector('.sidebar');
  if (!el) return;
  const r = S.route;
  const counts = {};
  const navItem = (name, ico, label, extra = '') => `<a class="nav-item ${r.name === name ? 'on' : ''}" href="#/${name}">${icon(ico)}${label}${extra}</a>`;
  const favLists = S.favorites.map(listById).filter(Boolean);
  el.innerHTML = `
    <div class="sidebar-top">
      <span class="brand"><span class="brand-mark">MK9</span><span>Criação <small>Tarefas</small></span></span>
      <button class="search-trigger" data-act="palette">${icon('search', 'sm')}Buscar<kbd>Ctrl K</kbd></button>
    </div>
    <nav class="nav">
      ${navItem('inicio', 'home', 'Início')}
      ${navItem('entrada', 'inbox', 'Caixa de entrada', S.unread ? `<span class="count">${S.unread > 99 ? '99+' : S.unread}</span>` : '')}
      ${navItem('minhas', 'user', 'Minhas tarefas')}
      ${navItem('carga', 'chart', 'Carga da equipe')}
      ${navItem('membros', 'users', 'Equipe')}
    </nav>
    <div class="sidebar-scroll">
      ${favLists.length ? `<div class="sidebar-section"><div class="sidebar-section-head"><span class="eyebrow">Favoritos</span></div>
        ${favLists.map((l) => `<div class="list-row ${r.name === 'lista' && r.id === l.id ? 'on' : ''}"><a class="grow" href="#/lista/${l.id}/${store.get('view:' + l.id, 'lista')}">${icon('star', 'sm')}<span class="ellipsis">${esc(l.name)}</span></a></div>`).join('')}</div>` : ''}
      <div class="sidebar-section">
        <div class="sidebar-section-head"><span class="eyebrow">Espaços</span><button class="icon-btn" data-act="new-space" title="Novo espaço" aria-label="Novo espaço">${icon('plus', 'sm')}</button></div>
        ${S.spaces.length ? S.spaces.map((s) => {
          const lists = S.lists.filter((l) => l.space_id === s.id && !folderById(l.folder_id));
          const folders = S.folders.filter((f) => f.space_id === s.id);
          const collapsed = collapsedSpaces.has(s.id);
          const listRow = (l) => `<div class="list-row ${r.name === 'lista' && r.id === l.id ? 'on' : ''}">
                <a class="grow" href="#/lista/${l.id}/${store.get('view:' + l.id, 'lista')}"><span class="dot" style="color:${esc(s.color)}"></span><span class="ellipsis">${esc(l.name)}</span></a>
                <span class="actions"><button class="icon-btn" style="width:24px;height:24px" data-act="list-menu" data-id="${l.id}" aria-label="Opções da lista">${icon('more', 'sm')}</button></span>
              </div>`;
          return `<div class="space ${collapsed ? 'collapsed' : ''}">
            <div class="space-row ${r.name === 'espaco' && r.id === s.id ? 'on' : ''}">
              <button class="icon-btn" style="width:20px;height:20px" data-act="toggle-space" data-id="${s.id}" aria-label="Expandir">${icon('chevron', 'sm caret')}</button>
              <a class="grow" href="#/espaco/${s.id}/${store.get('view:' + s.id, 'lista')}"><span class="space-chip" style="background:${esc(s.color)}">${esc(initials(s.name)[0])}</span><span class="ellipsis">${esc(s.name)}</span></a>
              <span class="actions"><button class="icon-btn" style="width:24px;height:24px" data-act="space-menu" data-id="${s.id}" aria-label="Opções do espaço">${icon('more', 'sm')}</button>
              <button class="icon-btn" style="width:24px;height:24px" data-act="new-in-space" data-id="${s.id}" aria-label="Nova lista ou pasta">${icon('plus', 'sm')}</button></span>
            </div>
            <div class="space-lists">
              ${folders.map((f) => {
                const fl = S.lists.filter((l) => l.folder_id === f.id);
                return `<div class="folder ${collapsedSpaces.has(f.id) ? 'collapsed' : ''}">
                  <div class="list-row folder-row ${r.name === 'pasta' && r.id === f.id ? 'on' : ''}">
                    <button class="icon-btn" style="width:18px;height:18px;margin-left:-8px" data-act="toggle-space" data-id="${f.id}" aria-label="Expandir pasta">${icon('chevron', 'sm caret')}</button>
                    <a class="grow" href="#/pasta/${f.id}/${store.get('view:' + f.id, 'lista')}">${icon('folder', 'sm')}<span class="ellipsis">${esc(f.name)}</span></a>
                    <span class="actions"><button class="icon-btn" style="width:24px;height:24px" data-act="folder-menu" data-id="${f.id}" aria-label="Opções da pasta">${icon('more', 'sm')}</button>
                    <button class="icon-btn" style="width:24px;height:24px" data-act="new-list" data-id="${s.id}" data-folder="${f.id}" aria-label="Nova lista na pasta">${icon('plus', 'sm')}</button></span>
                  </div>
                  <div class="folder-lists">${fl.map(listRow).join('') || `<button class="list-row faint" style="width:100%" data-act="new-list" data-id="${s.id}" data-folder="${f.id}">${icon('plus', 'sm')} Nova lista</button>`}</div>
                </div>`;
              }).join('')}
              ${lists.map(listRow).join('')}
              ${!lists.length && !folders.length ? `<button class="list-row faint" style="width:100%" data-act="new-list" data-id="${s.id}">${icon('plus', 'sm')} Nova lista</button>` : ''}
            </div>
          </div>`;
        }).join('') : `<button class="nav-item" data-act="new-space">${icon('plus', 'sm')}Criar primeiro espaço</button>`}
      </div>
    </div>
    <div class="sidebar-foot">
      ${S.timer ? `<div class="timer-pill"><span class="rec" aria-hidden="true"></span><a class="ellipsis" href="${taskHash(S.timer.task_id)}" title="${esc(S.timer.title)}">${esc(S.timer.title)}</a>
        <span class="elapsed" data-timer-elapsed>${elapsed(S.timer.started_at)}</span><button class="icon-btn" data-act="timer-stop" title="Parar cronômetro" aria-label="Parar cronômetro">${icon('stop', 'sm')}</button></div>` : ''}
      <button class="me-btn" data-act="me-menu">${avatar(S.me, 'md')}<span style="min-width:0;flex:1"><span class="ellipsis" style="display:block">${esc(S.me.name)}</span><span class="caption faint ellipsis" style="display:block">${esc(S.me.email)}</span></span>${icon('more', 'sm')}</button>
    </div>`;
  void counts;
}

export function elapsed(iso) {
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`;
}
setInterval(() => {
  if (!S.timer) return;
  document.querySelectorAll('[data-timer-elapsed]').forEach((el) => { el.textContent = elapsed(el.dataset.since || S.timer.started_at); });
}, 1000);

function renderTop() {
  const top = document.querySelector('.topbar');
  const tb = document.querySelector('.toolbar-slot');
  if (!top) return;
  const r = S.route;
  const burger = `<button class="icon-btn mobile-only" data-act="nav" aria-label="Menu">${icon('menu')}</button>`;
  let title = '', crumbs = '', actions = '', hasViews = false;
  if (r.name === 'lista') {
    const l = listById(r.id), s = l && spaceById(l.space_id);
    if (!l) { top.innerHTML = burger; tb.innerHTML = ''; return; }
    crumbs = `<a href="#/espaco/${s.id}/${store.get('view:' + s.id, 'lista')}">${esc(s.name)}</a>`;
    const fav = S.favorites.includes(l.id);
    title = `${esc(l.name)}`;
    actions = `<button class="icon-btn" data-act="fav" data-id="${l.id}" title="${fav ? 'Remover dos favoritos' : 'Favoritar'}" aria-label="Favoritar" style="${fav ? 'color:var(--warning)' : ''}">${icon('star')}</button>
      <button class="icon-btn" data-act="list-menu" data-id="${l.id}" aria-label="Opções da lista">${icon('more')}</button>`;
    hasViews = true;
  } else if (r.name === 'espaco') {
    const s = spaceById(r.id);
    if (!s) { top.innerHTML = burger; tb.innerHTML = ''; return; }
    title = `<span class="space-chip" style="background:${esc(s.color)};width:28px;height:28px;font-size:13px">${esc(initials(s.name)[0])}</span>${esc(s.name)}`;
    crumbs = 'Espaço';
    actions = `<button class="icon-btn" data-act="space-menu" data-id="${s.id}" aria-label="Opções do espaço">${icon('more')}</button>`;
    hasViews = true;
  } else if (r.name === 'pasta') {
    const f = folderById(r.id), s = f && spaceById(f.space_id);
    if (!f) { top.innerHTML = burger; tb.innerHTML = ''; return; }
    crumbs = `<a href="#/espaco/${s.id}/${store.get('view:' + s.id, 'lista')}">${esc(s.name)}</a>`;
    title = `${icon('folder', 'lg')}${esc(f.name)}`;
    actions = `<button class="icon-btn" data-act="folder-menu" data-id="${f.id}" aria-label="Opções da pasta">${icon('more')}</button>`;
    hasViews = true;
  } else if (r.name === 'minhas') { title = 'Minhas tarefas'; crumbs = 'Atribuídas a você'; hasViews = true; }
  const titled = TASK_ROUTES.includes(r.name);
  top.innerHTML = titled ? `${burger}<div style="min-width:0;flex:1"><div class="crumbs">${crumbs}</div><div class="page-title"><h1 class="h-section" style="display:flex;align-items:center;gap:10px">${title}</h1>${actions}</div></div>
    <button class="btn btn-primary" data-act="new-task" aria-label="Nova tarefa">${icon('plus', 'sm')}<span class="btn-label">Nova tarefa</span></button>` : `${burger}`;
  top.style.display = titled ? '' : (innerWidth <= 860 ? '' : 'none');
  if (!hasViews) { tb.innerHTML = ''; return; }
  const f = S.filters;
  const view = r.view;
  tb.innerHTML = `<div class="toolbar">
    <div class="tabs" role="tablist">
      ${[['lista', 'list', 'Lista'], ['quadro', 'board', 'Quadro'], ['calendario', 'calendar', 'Calendário'], ['linha', 'timeline', 'Linha do tempo']].map(([v, ic, label]) =>
        `<a class="tab ${view === v ? 'on' : ''}" role="tab" href="${r.name === 'minhas' ? `#/minhas/_/${v}` : `#/${r.name}/${r.id}/${v}`}">${icon(ic, 'sm')}${label}</a>`).join('')}
    </div>
    <span class="spacer"></span>
    <div class="filter-search">${icon('search', 'sm')}<input class="input" data-filter-q placeholder="Filtrar tarefas" value="${esc(f.q)}" aria-label="Filtrar tarefas"></div>
    <button class="chip-btn ${f.assignees.length ? 'on' : ''}" data-act="filter-assignee">${icon('user', 'sm')}Responsável${f.assignees.length ? ` · ${f.assignees.length}` : ''}</button>
    <button class="chip-btn ${f.priorities.length ? 'on' : ''}" data-act="filter-priority">${icon('flag', 'sm')}Prioridade${f.priorities.length ? ` · ${f.priorities.length}` : ''}</button>
    ${view === 'lista' ? `<button class="chip-btn ${f.group !== 'status' ? 'on' : ''}" data-act="group">${icon('layers', 'sm')}Agrupar: ${GROUPS[f.group]}</button>` : ''}
    <button class="chip-btn ${f.sort !== 'manual' ? 'on' : ''}" data-act="sort">${icon('sort', 'sm')}${{ manual: 'Ordem manual', due: 'Prazo', priority: 'Prioridade', title: 'Nome', created: 'Mais recentes' }[f.sort]}</button>
    <button class="chip-btn ${f.showDone ? '' : 'on'}" data-act="toggle-done">${icon('check', 'sm')}${f.showDone ? 'Ocultar concluídas' : 'Mostrando abertas'}</button>
  </div>`;
}

const GROUPS = { status: 'Status', assignee: 'Responsável', priority: 'Prioridade', due: 'Prazo', list: 'Lista', none: 'Nenhum' };

// ---------- filtros ----------
function filtered(tasks) {
  const f = S.filters;
  const q = f.q.trim().toLowerCase();
  let out = tasks.filter((t) => !t.archived);
  // Em listas e espaços, subtarefas aparecem dentro da tarefa pai (como no ClickUp)
  if (['lista', 'espaco', 'pasta'].includes(S.route.name)) out = out.filter((t) => !t.parent_id);
  if (q) out = out.filter((t) => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
  if (f.assignees.length) out = out.filter((t) => f.assignees.some((a) => a === '__none' ? !t.assignees.length : t.assignees.includes(a)));
  if (f.priorities.length) out = out.filter((t) => f.priorities.includes(t.priority || '__none'));
  if (!f.showDone) out = out.filter((t) => !isDone(t));
  return sortTasks(out);
}
function sortTasks(arr) {
  const s = S.filters.sort;
  const by = {
    manual: (a, b) => a.position - b.position,
    due: (a, b) => (a.due_date || '9999') < (b.due_date || '9999') ? -1 : (a.due_date || '9999') > (b.due_date || '9999') ? 1 : a.position - b.position,
    priority: (a, b) => (PRIORITY[a.priority]?.rank ?? 9) - (PRIORITY[b.priority]?.rank ?? 9) || a.position - b.position,
    title: (a, b) => a.title.localeCompare(b.title, 'pt-BR'),
    created: (a, b) => (a.created_at < b.created_at ? 1 : -1),
  }[s];
  return [...arr].sort(by);
}

// Colunas de status para a visão atual (une listas diferentes pelo id do status)
function viewLists(tasks = S.tasks) {
  const r = S.route;
  if (r.name === 'lista') return [listById(r.id)].filter(Boolean);
  if (r.name === 'espaco') return S.lists.filter((l) => l.space_id === r.id);
  if (r.name === 'pasta') return S.lists.filter((l) => l.folder_id === r.id);
  return [...new Set(tasks.map((t) => t.list_id))].map(listById).filter(Boolean);
}
function viewStatuses(tasks) {
  const lists = viewLists(tasks);
  const seen = new Map();
  for (const l of lists) for (const s of l.statuses) if (!seen.has(s.id)) seen.set(s.id, s);
  for (const t of tasks) if (!seen.has(t.status)) seen.set(t.status, statusOf(t));
  return [...seen.values()];
}
function defaultListForView() {
  const r = S.route;
  if (r.name === 'lista') return listById(r.id);
  if (r.name === 'espaco' || r.name === 'pasta') return viewLists()[0] || null;
  return null;
}

// ---------- conteúdo ----------
export function renderContent() {
  const c = document.querySelector('.content');
  if (!c) return;
  const r = S.route;
  const scroll = c.scrollTop, scrollX = c.firstElementChild?.scrollLeft;
  if (S.loadingTasks && [...TASK_ROUTES, 'inicio', 'carga'].includes(r.name)) { c.innerHTML = '<div class="loading">Carregando…</div>'; return; }
  if ((r.name === 'lista' && !listById(r.id)) || (r.name === 'espaco' && !spaceById(r.id)) || (r.name === 'pasta' && !folderById(r.id))) {
    c.innerHTML = `<div class="empty"><div class="h-card">Não encontramos esta página</div><p>Ela pode ter sido arquivada.</p><a class="btn btn-ghost" href="#/inicio">Voltar ao início</a></div>`;
    return;
  }
  if (r.name === 'inicio') c.innerHTML = homeView();
  else if (r.name === 'entrada') { c.innerHTML = '<div class="loading">Carregando…</div>'; inboxView(c); return; }
  else if (r.name === 'membros') c.innerHTML = membersView();
  else if (r.name === 'carga') c.innerHTML = workloadView();
  else if (r.name === 'perfil') { c.innerHTML = profileView(); bindProfile(c); }
  else if (r.view === 'quadro') c.innerHTML = boardView();
  else if (r.view === 'calendario') c.innerHTML = calendarView();
  else if (r.view === 'linha') { c.innerHTML = timelineView(); }
  else c.innerHTML = listView();
  c.scrollTop = scroll;
  if (scrollX && c.firstElementChild) c.firstElementChild.scrollLeft = scrollX;
  if (r.view === 'linha' && TASK_ROUTES.includes(r.name)) {
    const tl = c.querySelector('.tl-scroll');
    if (tl) tl.scrollLeft = S.tlScroll ?? tl.scrollLeft;
  }
  applyLanding();
  renderBulkBar();
}

// Ao soltar um cartão, ele "pousa" partindo de onde a pessoa soltou, em vez de saltar para o lugar.
// Sobrevive a re-renderizações: retoma a animação do ponto em que estava.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let landing = null;
function applyLanding() {
  if (!landing || reduceMotion.matches) return;
  const elapsed = performance.now() - landing.t;
  if (elapsed > 420) { landing = null; return; }
  const el = document.querySelector(`.content [data-drag="${CSS.escape(landing.id)}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const dx = landing.x - r.left, dy = landing.y - r.top;
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
  const anim = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
  anim.currentTime = elapsed;
}

function emptyState() {
  const r = S.route;
  if (r.name === 'minhas') return `<div class="empty"><div class="h-card">Nada atribuído a você</div><p>Quando alguém te colocar como responsável, a tarefa aparece aqui.</p></div>`;
  if ((r.name === 'espaco' || r.name === 'pasta') && !viewLists().length) return `<div class="empty"><div class="h-card">Este espaço ainda não tem listas</div><button class="btn btn-primary" data-act="new-list" data-id="${r.id}">${icon('plus', 'sm')}Criar lista</button></div>`;
  return '';
}

function rowHtml(t, { showList = false } = {}) {
  const st = statusOf(t), done = st.type === 'done';
  const l = listById(t.list_id);
  const parent = t.parent_id ? S.tasks.find((x) => x.id === t.parent_id) : null;
  const drag = S.filters.sort === 'manual' && S.filters.group === 'status' ? 'draggable="true"' : '';
  const sel = S.selected.has(t.id);
  return `<div class="row ${done ? 'done' : ''} ${sel ? 'selected' : ''}" data-task="${t.id}" data-drag="${t.id}" ${drag}>
    <div class="title-cell">
      <input type="checkbox" class="sel" data-act="select" data-id="${t.id}" ${sel ? 'checked' : ''} aria-label="Selecionar" data-stop>
      <input type="checkbox" class="check" data-act="toggle-done-task" data-id="${t.id}" ${done ? 'checked' : ''} aria-label="Concluir" data-stop>
      ${t.blocked && !done ? `<span class="blocked" title="Esperando outra tarefa">${icon('lock', 'sm')}</span>` : ''}
      <span class="t">${esc(t.title)}</span>
      ${parent ? `<span class="sub-of">${icon('subtask', 'sm')} ${esc(parent.title)}</span>` : ''}
      ${showList && l ? `<span class="sub-of">${esc(l.name)}</span>` : ''}
      <span class="meta-icons">
        ${t.subtasks.total ? `<span title="Subtarefas">${icon('subtask', 'sm')}${t.subtasks.done}/${t.subtasks.total}</span>` : ''}
        ${t.checklist.total ? `<span title="Checklist">${icon('checklist', 'sm')}${t.checklist.done}/${t.checklist.total}</span>` : ''}
        ${t.comment_count ? `<span title="Comentários">${icon('comment', 'sm')}${t.comment_count}</span>` : ''}
        ${t.attachment_count ? `<span title="Anexos">${icon('paperclip', 'sm')}${t.attachment_count}</span>` : ''}
        ${t.timers?.length ? `<span class="running" title="Cronômetro rodando">${icon('clock', 'sm')}</span>` : t.time_spent ? `<span title="Tempo registrado">${icon('clock', 'sm')}${fmtMinutes(t.time_spent)}</span>` : ''}
      </span>
      <span class="row-tags">${t.tags.map((id) => tagHtml(tagById(id))).join('')}</span>
    </div>
    <div><button class="cell-btn" data-act="assignees" data-id="${t.id}" data-stop aria-label="Responsáveis">${avatars(t.assignees)}</button></div>
    <div><label class="cell-btn" data-stop>${t.due_date ? dateHtml(t) : `<span class="date faint">${icon('calendar', 'sm')}—</span>`}
      <input type="date" class="sr-only" data-date-field="due_date" data-id="${t.id}" value="${esc(t.due_date || '')}" aria-label="Prazo"></label></div>
    <div><button class="cell-btn" data-act="priority" data-id="${t.id}" data-stop>${prioHtml(t.priority)}</button></div>
    <div style="min-width:0">${statusPill(st, 'button', `data-act="status" data-id="${t.id}" data-stop`)}</div>
    <div><button class="icon-btn" data-act="task-menu" data-id="${t.id}" data-stop aria-label="Mais opções">${icon('more', 'sm')}</button></div>
  </div>`;
}

// Grupos da visão em lista, como o "Agrupar por" do ClickUp.
// Cada grupo sabe filtrar suas tarefas e o que pré-preencher ao criar uma tarefa nele.
function listGroups(tasks) {
  const g = S.filters.group, t0 = today();
  if (g === 'status') return viewStatuses(S.tasks).map((st) => ({
    id: st.id, head: statusPill(st), match: (t) => t.status === st.id, preset: { status: st.id }, drop: st.id, hideEmpty: !S.filters.showDone && st.type === 'done',
  }));
  if (g === 'assignee') return [
    ...S.users.filter((u) => u.active || tasks.some((t) => t.assignees.includes(u.id))).map((u) => ({
      id: u.id, head: `${avatar(u)}<span class="h-card" style="font-size:14px">${esc(u.name)}</span>`, match: (t) => t.assignees.includes(u.id), preset: { assignees: [u.id] }, hideEmpty: true,
    })),
    { id: '__none', head: `<span class="avatar-empty">${icon('user', 'sm')}</span><span class="h-card muted" style="font-size:14px">Sem responsável</span>`, match: (t) => !t.assignees.length, preset: {} },
  ];
  if (g === 'priority') return [...Object.keys(PRIORITY), null].map((k) => ({
    id: k || '__none', head: k ? `${prioHtml(k)}` : '<span class="prio faint">Sem prioridade</span>', match: (t) => (t.priority || null) === k, preset: { priority: k }, hideEmpty: true,
  }));
  if (g === 'due') {
    const wk = addDays(t0, 7);
    return [
      { id: 'late', head: '<span class="h-card" style="font-size:14px;color:var(--danger)">Atrasadas</span>', match: (t) => t.due_date && t.due_date < t0 && !isDone(t), preset: {}, hideEmpty: true },
      { id: 'today', head: '<span class="h-card" style="font-size:14px">Hoje</span>', match: (t) => t.due_date === t0, preset: { due_date: t0 } },
      { id: 'tomorrow', head: '<span class="h-card" style="font-size:14px">Amanhã</span>', match: (t) => t.due_date === addDays(t0, 1), preset: { due_date: addDays(t0, 1) } },
      { id: 'week', head: '<span class="h-card" style="font-size:14px">Próximos 7 dias</span>', match: (t) => t.due_date > addDays(t0, 1) && t.due_date <= wk, preset: {}, hideEmpty: true },
      { id: 'later', head: '<span class="h-card" style="font-size:14px">Depois</span>', match: (t) => t.due_date > wk, preset: {}, hideEmpty: true },
      { id: 'past', head: '<span class="h-card muted" style="font-size:14px">Prazo passado (concluídas)</span>', match: (t) => t.due_date && t.due_date < t0 && isDone(t), preset: {}, hideEmpty: true },
      { id: 'none', head: '<span class="h-card muted" style="font-size:14px">Sem prazo</span>', match: (t) => !t.due_date, preset: {} },
    ];
  }
  if (g === 'list') return viewLists(tasks).map((l) => ({
    id: l.id, head: `${icon('list', 'sm')}<span class="h-card" style="font-size:14px">${esc(l.name)}</span><span class="faint caption">${esc(spaceById(l.space_id)?.name || '')}</span>`,
    match: (t) => t.list_id === l.id, preset: { list_id: l.id },
  }));
  return [{ id: 'all', head: '<span class="h-card" style="font-size:14px">Todas as tarefas</span>', match: () => true, preset: {} }];
}

function listView() {
  const r = S.route;
  const tasks = filtered(S.tasks);
  const canAdd = r.name !== 'minhas' && defaultListForView();
  const empty = emptyState();
  if (empty && !tasks.length) return empty;
  const multi = r.name !== 'lista';
  return `<div class="page ${S.selected.size ? 'selecting' : ''}">${listGroups(tasks).map((grp) => {
    const rows = tasks.filter(grp.match);
    if (!rows.length && (!canAdd || grp.hideEmpty)) return '';
    const key = (r.id || r.name) + ':' + S.filters.group + ':' + grp.id;
    const preset = esc(JSON.stringify(grp.preset));
    return `<section class="group ${collapsedGroups.has(key) ? 'collapsed' : ''}" ${grp.drop ? `data-drop-status="${esc(grp.drop)}"` : ''}>
      <div class="group-head">
        <button class="icon-btn" style="width:22px;height:22px" data-act="toggle-group" data-key="${esc(key)}" aria-label="Recolher">${icon('chevron', 'sm caret')}</button>
        ${grp.head}<span class="count">${rows.length}</span>
        ${rows.length ? `<button class="btn btn-text btn-sm group-select" data-act="select-group" data-ids="${esc(rows.map((t) => t.id).join(','))}">Selecionar</button>` : ''}
      </div>
      <div class="rows">
        ${rows.length ? `<div class="row-head"><span>Nome</span><span>Responsável</span><span>Prazo</span><span>Prioridade</span><span>Status</span><span></span></div>` : ''}
        ${rows.map((t) => rowHtml(t, { showList: multi })).join('')}
        ${canAdd ? `<div class="add-row">${icon('plus', 'sm')}<input data-quick-add="${preset}" placeholder="Adicionar tarefa e pressionar Enter" aria-label="Nova tarefa"></div>` : ''}
      </div>
    </section>`;
  }).join('') || `<div class="empty"><div class="h-card">Nenhuma tarefa encontrada</div><p>Ajuste os filtros ou crie uma nova tarefa.</p></div>`}</div>`;
}

// ---------- ações em massa ----------
function renderBulkBar() {
  let bar = document.querySelector('.bulkbar');
  for (const id of [...S.selected]) if (!S.tasks.some((t) => t.id === id)) S.selected.delete(id);
  const n = S.selected.size;
  if (!n || !TASK_ROUTES.includes(S.route.name)) {
    if (bar && !bar.classList.contains('leaving')) { bar.classList.add('leaving'); setTimeout(() => bar.remove(), 160); }
    return;
  }
  if (!bar || bar.classList.contains('leaving')) { bar?.remove(); bar = document.createElement('div'); bar.className = 'bulkbar'; bar.setAttribute('role', 'toolbar'); document.body.append(bar); }
  bar.innerHTML = `<span class="n">${n} selecionada${n > 1 ? 's' : ''}</span>
    <button class="chip-btn" data-bulk="status">${icon('check', 'sm')}Status</button>
    <button class="chip-btn" data-bulk="assignee">${icon('user', 'sm')}Responsável</button>
    <button class="chip-btn" data-bulk="priority">${icon('flag', 'sm')}Prioridade</button>
    <label class="chip-btn">${icon('calendar', 'sm')}Prazo<input type="date" class="sr-only" data-bulk-date></label>
    <button class="chip-btn" data-bulk="move">${icon('move', 'sm')}Mover</button>
    <button class="chip-btn" data-bulk="archive">${icon('archive', 'sm')}Arquivar</button>
    <button class="chip-btn danger" data-bulk="delete">${icon('trash', 'sm')}Excluir</button>
    <button class="icon-btn" data-bulk="clear" aria-label="Limpar seleção">${icon('x', 'sm')}</button>`;
  if (!bar.dataset.bound) {
    bar.dataset.bound = '1';
    bar.addEventListener('click', (e) => {
      const lbl = e.target.closest('label.chip-btn');
      if (lbl) { const inp = lbl.querySelector('input'); try { inp.showPicker(); } catch { inp.focus(); } return; }
      const b = e.target.closest('[data-bulk]');
      if (b) bulkAction(b.dataset.bulk, b);
    });
    bar.addEventListener('change', (e) => { if (e.target.matches('[data-bulk-date]')) bulkApply((t) => ({ due_date: e.target.value || null }), 'Prazo atualizado'); });
  }
}
async function bulkApply(makePatch, msg) {
  const tasks = [...S.selected].map(taskOf).filter(Boolean);
  let ok = 0, skipped = 0;
  await Promise.all(tasks.map(async (t) => {
    const p = makePatch(t);
    if (!p) { skipped++; return; }
    try { await api('PATCH', `/api/tasks/${t.id}`, { ...p, force: true }); ok++; } catch { skipped++; }
  }));
  await loadTasks(); renderContent();
  toast(`${msg}: ${ok} tarefa${ok !== 1 ? 's' : ''}${skipped ? ` (${skipped} sem alteração)` : ''}`);
}
function bulkAction(kind, anchor) {
  const tasks = [...S.selected].map(taskOf).filter(Boolean);
  if (kind === 'clear') { S.selected.clear(); renderContent(); return; }
  if (kind === 'status') {
    const sts = viewStatuses(tasks);
    menuPopover(anchor, {
      items: () => sts.map((s) => ({ id: s.id, html: statusPill(s) })),
      onPick: (id) => {
        const name = sts.find((s) => s.id === id)?.name.toLowerCase();
        bulkApply((t) => { const l = listById(t.list_id); const m = l.statuses.find((s) => s.id === id) || l.statuses.find((s) => s.name.toLowerCase() === name); return m ? { status: m.id } : null; }, 'Status alterado');
      },
    });
  }
  if (kind === 'assignee') menuPopover(anchor, {
    search: true,
    items: () => [{ label: 'Adicionar responsável' }, ...S.users.filter((u) => u.active).map((u) => ({ id: u.id, text: u.name, html: `${avatar(u)}${esc(u.name)}` })),
      { sep: true }, { id: '__clear', text: 'remover', html: '<span class="muted">Remover todos os responsáveis</span>' }],
    onPick: (id) => bulkApply((t) => ({ assignees: id === '__clear' ? [] : [...new Set([...t.assignees, id])] }), 'Responsáveis atualizados'),
  });
  if (kind === 'priority') menuPopover(anchor, {
    items: () => [...Object.keys(PRIORITY).map((k) => ({ id: k, html: prioHtml(k) })), { sep: true }, { id: '', html: '<span class="muted">Sem prioridade</span>' }],
    onPick: (id) => bulkApply(() => ({ priority: id || null }), 'Prioridade alterada'),
  });
  if (kind === 'move') menuPopover(anchor, {
    search: true, width: 280,
    items: () => S.spaces.flatMap((s) => { const ls = S.lists.filter((l) => l.space_id === s.id); return ls.length ? [{ label: s.name }, ...ls.map((l) => ({ id: l.id, text: s.name + ' ' + l.name, html: esc(l.name) }))] : []; }),
    onPick: async (id) => { await bulkApply((t) => (t.list_id === id ? null : { list_id: id }), 'Movidas para ' + listById(id).name); S.selected.clear(); renderContent(); },
  });
  if (kind === 'archive') { bulkApply(() => ({ archived: true }), 'Arquivadas').then(() => { S.selected.clear(); renderContent(); }); }
  if (kind === 'delete') {
    confirmDialog(`Excluir ${tasks.length} tarefa${tasks.length > 1 ? 's' : ''}?`, 'Elas e suas subtarefas, comentários e anexos serão apagados para sempre.', { ok: 'Excluir', danger: true }).then(async (yes) => {
      if (!yes) return;
      await Promise.all(tasks.map((t) => api('DELETE', `/api/tasks/${t.id}`).catch(() => {})));
      S.selected.clear(); await loadTasks(); renderContent(); toast('Tarefas excluídas');
    });
  }
}

function cardHtml(t) {
  const st = statusOf(t), done = st.type === 'done';
  const total = t.checklist.total + t.subtasks.total, dn = t.checklist.done + t.subtasks.done;
  const r = S.route;
  return `<article class="card ${done ? 'done' : ''}" data-task="${t.id}" data-drag="${t.id}" draggable="true">
    ${r.name !== 'lista' || (t.blocked && !done) ? `<span class="caption faint" style="display:flex;gap:6px;align-items:center">${t.blocked && !done ? `<span class="blocked" title="Esperando outra tarefa">${icon('lock', 'sm')}</span>` : ''}${r.name !== 'lista' ? esc(listById(t.list_id)?.name || '') : 'Aguardando'}</span>` : ''}
    ${t.tags.length ? `<div class="card-tags">${t.tags.map((id) => tagHtml(tagById(id))).join('')}</div>` : ''}
    <div class="t">${esc(t.title)}</div>
    ${total ? `<div class="progress" title="${dn}/${total} itens"><i style="width:${Math.round((dn / total) * 100)}%"></i></div>` : ''}
    <div class="card-foot">
      <span style="display:flex;gap:10px;align-items:center">${dateHtml(t)}${t.priority ? prioHtml(t.priority, false) : ''}
        <span class="meta-icons">${t.comment_count ? `<span>${icon('comment', 'sm')}${t.comment_count}</span>` : ''}${t.attachment_count ? `<span>${icon('paperclip', 'sm')}${t.attachment_count}</span>` : ''}${t.subtasks.total ? `<span>${icon('subtask', 'sm')}${t.subtasks.done}/${t.subtasks.total}</span>` : ''}</span></span>
      <button class="cell-btn" data-act="assignees" data-id="${t.id}" data-stop style="margin:0">${avatars(t.assignees, 2)}</button>
    </div>
  </article>`;
}

function boardView() {
  const r = S.route;
  const tasks = filtered(S.tasks);
  const empty = emptyState();
  if (empty && !tasks.length) return empty;
  const statuses = viewStatuses(S.tasks);
  const canAdd = r.name !== 'minhas' && defaultListForView();
  return `<div class="board">${statuses.filter((st) => S.filters.showDone || st.type !== 'done').map((st) => {
    const cards = tasks.filter((t) => t.status === st.id);
    return `<section class="column" data-drop-status="${esc(st.id)}">
      <div class="column-head">${statusPill(st)}<span class="count">${cards.length}</span></div>
      <div class="column-body">${cards.map(cardHtml).join('')}</div>
      ${canAdd ? `<div class="add-row">${icon('plus', 'sm')}<input data-quick-add="${esc(st.id)}" placeholder="Nova tarefa" aria-label="Nova tarefa em ${esc(st.name)}"></div>` : ''}
    </section>`;
  }).join('')}</div>`;
}

function calendarView() {
  const tasks = filtered(S.tasks);
  const m = S.calMonth;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const days = [];
  for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
  if (days[35].getMonth() !== m.getMonth()) days.length = 35;
  const byDay = {};
  for (const t of tasks) if (t.due_date) (byDay[t.due_date] ||= []).push(t);
  const noDate = tasks.filter((t) => !t.due_date && !isDone(t)).length;
  const t0 = today();
  const canAdd = S.route.name !== 'minhas' ? defaultListForView() : S.lists[0];
  return `<div class="cal">
    <div class="cal-head">
      <button class="icon-btn" data-act="cal-prev" aria-label="Mês anterior">${icon('chevronLeft')}</button>
      <h2 class="h-section" style="min-width:200px">${MONTHS_FULL[m.getMonth()]} ${m.getFullYear()}</h2>
      <button class="icon-btn" data-act="cal-next" aria-label="Próximo mês">${icon('chevronRight')}</button>
      <button class="btn btn-ghost btn-sm" data-act="cal-today">Hoje</button>
      <span class="spacer" style="flex:1"></span>
      ${noDate ? `<span class="caption faint">${noDate} tarefa${noDate > 1 ? 's' : ''} aberta${noDate > 1 ? 's' : ''} sem prazo</span>` : ''}
    </div>
    <div class="cal-grid">
      ${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
      ${days.map((d) => {
        const k = ymd(d), list = byDay[k] || [];
        return `<div class="cal-day ${d.getMonth() !== m.getMonth() ? 'other' : ''} ${k === t0 ? 'today' : ''}" data-drop-date="${k}">
          <div class="day-head"><span class="n">${d.getDate()}</span>${canAdd ? `<button class="icon-btn" data-act="cal-add" data-date="${k}" aria-label="Adicionar tarefa em ${k}">${icon('plus', 'sm')}</button>` : ''}</div>
          ${list.slice(0, 4).map((t) => `<div class="cal-task ${isDone(t) ? 'done' : ''}" data-task="${t.id}" data-drag="${t.id}" draggable="true" style="--c:${esc(statusOf(t).color)}"><span class="dot"></span><span class="ellipsis">${esc(t.title)}</span></div>`).join('')}
          ${list.length > 4 ? `<button class="cal-more" data-act="cal-more" data-date="${k}">+${list.length - 4} mais</button>` : ''}
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

// ---------- linha do tempo (Gantt) ----------
const TL_DAY = 36, TL_DAYS = 42;
function tlStartDate() {
  if (!S.tlStart) { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7); S.tlStart = ymd(d); }
  return S.tlStart;
}
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T12:00:00') - Date.parse(a + 'T12:00:00')) / 864e5);
function timelineView() {
  const tasks = filtered(S.tasks);
  const empty = emptyState();
  if (empty && !tasks.length) return empty;
  const start = tlStartDate(), t0 = today();
  const days = Array.from({ length: TL_DAYS }, (_, i) => addDays(start, i));
  const dated = tasks.filter((t) => t.start_date || t.due_date).sort((a, b) => ((a.start_date || a.due_date) < (b.start_date || b.due_date) ? -1 : 1));
  const undated = tasks.filter((t) => !t.start_date && !t.due_date && !isDone(t));
  const W = TL_DAY * TL_DAYS;
  const months = [];
  for (const d of days) { const k = d.slice(0, 7); if (!months.length || months[months.length - 1].k !== k) months.push({ k, n: 0, m: +d.slice(5, 7) - 1 }); months[months.length - 1].n++; }
  const todayX = dayDiff(start, t0) * TL_DAY;
  const row = (t) => {
    const s = t.start_date || t.due_date, e = t.due_date || t.start_date;
    const a = dayDiff(start, s < e ? s : e), b = dayDiff(start, s < e ? e : s) + 1;
    const visible = b > 0 && a < TL_DAYS;
    const st = statusOf(t);
    return `<div class="tl-row" data-task="${t.id}">
      <div class="tl-name"><input type="checkbox" class="check" data-act="toggle-done-task" data-id="${t.id}" ${isDone(t) ? 'checked' : ''} aria-label="Concluir" data-stop>
        <span class="ellipsis ${isDone(t) ? 'faint' : ''}">${esc(t.title)}</span>${avatars(t.assignees, 2)}</div>
      <div class="tl-track" style="width:${W}px" data-tl-track="${t.id}" data-stop>
        ${visible ? `<div class="tl-bar ${isDone(t) ? 'done' : ''}" data-tl-bar="${t.id}" style="left:${a * TL_DAY}px;width:${(b - a) * TL_DAY - 4}px;--c:${esc(st.color)}" title="${esc(t.title)} · ${fmtDate(s)} → ${fmtDate(e)}">
          <span class="tl-edge l" data-edge="start"></span><span class="ellipsis">${esc(t.title)}</span><span class="tl-edge r" data-edge="end"></span></div>`
          : `<span class="tl-off caption faint" style="left:${a < 0 ? 8 : W - 140}px">${a < 0 ? '← ' + fmtDate(e) : fmtDate(s) + ' →'}</span>`}
      </div></div>`;
  };
  return `<div class="tl">
    <div class="cal-head" style="padding:0 0 12px">
      <button class="icon-btn" data-act="tl-prev" aria-label="Semana anterior">${icon('chevronLeft')}</button>
      <button class="icon-btn" data-act="tl-next" aria-label="Próxima semana">${icon('chevronRight')}</button>
      <button class="btn btn-ghost btn-sm" data-act="tl-today">Hoje</button>
      <span class="caption faint" style="margin-left:8px">Arraste as barras para mudar as datas. Puxe as pontas para alongar.</span>
    </div>
    <div class="tl-scroll">
      <div class="tl-inner" style="width:calc(${W}px + var(--name-w))">
        <div class="tl-head">
          <div class="tl-name tl-corner"><span class="eyebrow">Tarefa</span></div>
          <div style="width:${W}px">
            <div class="tl-months">${months.map((m) => `<span style="width:${m.n * TL_DAY}px">${MONTHS_FULL[m.m]}</span>`).join('')}</div>
            <div class="tl-days">${days.map((d) => { const wd = new Date(d + 'T12:00:00').getDay(); return `<span class="${d === t0 ? 'today' : ''} ${wd === 0 || wd === 6 ? 'we' : ''}" style="width:${TL_DAY}px">${+d.slice(8)}</span>`; }).join('')}</div>
          </div>
        </div>
        <div class="tl-body" style="--today:${todayX}px;--w:${W}px">
          <div class="tl-grid" style="width:${W}px">${days.map((d) => { const wd = new Date(d + 'T12:00:00').getDay(); return `<span class="${wd === 0 || wd === 6 ? 'we' : ''}" style="width:${TL_DAY}px"></span>`; }).join('')}</div>
          ${todayX >= 0 && todayX < W ? `<div class="tl-today" style="left:calc(var(--name-w) + ${todayX + TL_DAY / 2}px)"></div>` : ''}
          ${dated.map(row).join('')}
          ${undated.length ? `<div class="tl-section"><span class="eyebrow">Sem datas · clique na linha do dia para agendar</span></div>${undated.map(row).join('')}` : ''}
          ${!dated.length && !undated.length ? '<div class="empty">Nenhuma tarefa para mostrar</div>' : ''}
        </div>
      </div>
    </div>
  </div>`;
}

// Arraste das barras: segue o ponteiro 1:1 (respeitando onde foi pego) e encaixa no dia ao soltar.
function bindTimeline() {
  let d = null;
  document.addEventListener('pointerdown', (e) => {
    const track = e.target.closest('.tl-track');
    if (!track || e.button !== 0) return;
    const bar = e.target.closest('.tl-bar');
    const t = taskOf(track.dataset.tlTrack);
    if (!t) return;
    if (!bar) {
      if (t.start_date || t.due_date) return;
      const day = addDays(tlStartDate(), Math.floor((e.clientX - track.getBoundingClientRect().left) / TL_DAY));
      patchTask(t.id, { start_date: day, due_date: day }).catch(() => {});
      return;
    }
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const edge = e.target.closest('[data-edge]')?.dataset.edge || 'move';
    d = { t, bar, edge, x0: e.clientX, left: bar.offsetLeft, width: bar.offsetWidth, moved: false, id: e.pointerId };
    bar.classList.add('dragging');
  });
  document.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 4) return;
    d.moved = true;
    if (d.edge === 'move') d.bar.style.left = d.left + dx + 'px';
    else if (d.edge === 'end') d.bar.style.width = Math.max(TL_DAY - 4, d.width + dx) + 'px';
    else { const w = Math.max(TL_DAY - 4, d.width - dx); d.bar.style.left = d.left + (d.width - w) + 'px'; d.bar.style.width = w + 'px'; }
  });
  const end = (e) => {
    if (!d || e.pointerId !== d.id) return;
    const { t, bar, edge, moved } = d; d = null;
    bar.classList.remove('dragging');
    if (!moved) { go(taskHash(t.id)); return; }
    const start = tlStartDate();
    const a = Math.round(bar.offsetLeft / TL_DAY), n = Math.max(1, Math.round((bar.offsetWidth + 4) / TL_DAY));
    // encaixa no dia mais próximo com uma transição curta, partindo de onde a barra está
    bar.style.left = a * TL_DAY + 'px'; bar.style.width = n * TL_DAY - 4 + 'px';
    const s = addDays(start, a), en = addDays(start, a + n - 1);
    const patch = edge === 'move' || edge === 'start' ? { start_date: s, due_date: en } : { start_date: t.start_date || s, due_date: en };
    if (!t.start_date && edge === 'end') patch.start_date = s;
    if (patch.start_date !== t.start_date || patch.due_date !== t.due_date) setTimeout(() => patchTask(t.id, patch).catch(() => {}), 180);
  };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  document.addEventListener('scroll', (e) => { if (e.target.classList?.contains('tl-scroll')) S.tlScroll = e.target.scrollLeft; }, true);
}

// ---------- carga de trabalho da equipe ----------
function workloadView() {
  const t0 = today();
  const days = Array.from({ length: 7 }, (_, i) => addDays(t0, i));
  const open = S.tasks.filter((t) => !t.archived && !isDone(t));
  const users = S.users.filter((u) => u.active);
  const logBy = {};
  for (const e of S.timeLog) logBy[e.user_id] = (logBy[e.user_id] || 0) + e.minutes;
  const WD = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const cell = (u, key, list) => {
    const est = list.reduce((m, t) => m + (t.time_estimate || 0), 0);
    const heavy = list.length >= 5 || est > 8 * 60;
    return `<button class="wl-cell ${list.length ? 'has' : ''} ${heavy ? 'heavy' : ''} ${key === 'late' && list.length ? 'late' : ''}" data-act="wl-cell" data-user="${u ? u.id : '__none'}" data-key="${key}" ${list.length ? '' : 'disabled'}
      style="--lvl:${Math.min(1, list.length / 5)}"><b>${list.length || '·'}</b>${est ? `<span>${fmtMinutes(est)}</span>` : ''}</button>`;
  };
  const bucket = (u, key) => open.filter((t) => (u ? t.assignees.includes(u.id) : !t.assignees.length)
    && (key === 'late' ? t.due_date && t.due_date < t0 : key === 'none' ? !t.due_date : key === 'later' ? t.due_date > days[6] : t.due_date === key));
  const rows = [...users, null].map((u) => {
    const mine = open.filter((t) => (u ? t.assignees.includes(u.id) : !t.assignees.length));
    if (!u && !mine.length) return '';
    const est = mine.reduce((m, t) => m + (t.time_estimate || 0), 0);
    return `<div class="wl-row"><div class="wl-who">${u ? `${avatar(u, 'md')}<span class="ellipsis">${esc(u.name)}</span>` : `<span class="avatar-empty">${icon('user', 'sm')}</span><span class="muted">Sem responsável</span>`}</div>
      ${cell(u, 'late', bucket(u, 'late'))}${days.map((d) => cell(u, d, bucket(u, d))).join('')}${cell(u, 'later', bucket(u, 'later'))}${cell(u, 'none', bucket(u, 'none'))}
      <div class="wl-total"><b>${mine.length}</b><span class="faint caption">${est ? fmtMinutes(est) + ' est.' : '—'}</span></div>
      <div class="wl-total"><b>${u && logBy[u.id] ? fmtMinutes(logBy[u.id]) : '—'}</b></div></div>`;
  }).join('');
  return `<div class="page-narrow" style="max-width:1280px">
    <h1 class="h-display" style="margin-bottom:8px">Carga da equipe</h1>
    <p class="muted" style="margin:0 0 24px">Tarefas abertas de cada pessoa por prazo, com a estimativa de horas. Células destacadas indicam dia pesado (5+ tarefas ou mais de 8h estimadas).</p>
    <div class="wl">
      <div class="wl-row wl-head"><div class="wl-who eyebrow">Pessoa</div><span>Atrasadas</span>${days.map((d, i) => `<span class="${i === 0 ? 'today' : ''}">${i === 0 ? 'Hoje' : WD[new Date(d + 'T12:00:00').getDay()]}<small>${+d.slice(8)}/${+d.slice(5, 7)}</small></span>`).join('')}<span>Depois</span><span>Sem prazo</span><span>Total aberto</span><span>Registrado 7 dias</span></div>
      ${rows}
    </div>
  </div>`;
}

function homeView() {
  const mine = S.tasks.filter((t) => t.assignees.includes(S.me.id) && !t.archived);
  const open = mine.filter((t) => !isDone(t));
  const t0 = today(), week = addDays(t0, 7), weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const overdue = open.filter((t) => t.due_date && t.due_date < t0);
  const due = open.filter((t) => t.due_date === t0);
  const upcoming = open.filter((t) => t.due_date && t.due_date > t0 && t.due_date <= week).sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
  const nodate = open.filter((t) => !t.due_date);
  const doneWeek = mine.filter((t) => isDone(t) && t.completed_at && t.completed_at >= weekAgo);
  const h = new Date().getHours();
  const hello = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  const mini = (t) => {
    const l = listById(t.list_id);
    return `<div class="mini-task" data-task="${t.id}"><input type="checkbox" class="check" data-act="toggle-done-task" data-id="${t.id}" data-stop aria-label="Concluir">
      <span class="t">${esc(t.title)}</span><span class="where">${esc(l?.name || '')}</span>${dateHtml(t)}${t.priority ? prioHtml(t.priority, false) : ''}</div>`;
  };
  const panel = (title, list, emptyMsg) => `<div class="panel"><div class="panel-head"><h3 class="h-card">${title} <span class="faint caption">${list.length}</span></h3></div>
    ${list.length ? list.slice(0, 12).map(mini).join('') : `<p class="faint caption" style="margin:0">${emptyMsg}</p>`}</div>`;
  const spaces = S.spaces.map((s) => {
    const ls = S.lists.filter((l) => l.space_id === s.id);
    const ts = S.tasks.filter((t) => ls.some((l) => l.id === t.list_id) && !t.parent_id);
    const d = ts.filter(isDone).length;
    return { s, total: ts.length, done: d };
  });
  return `<div class="page-narrow">
    <div class="greet"><h1 class="h-display">${hello}, ${esc(S.me.name.split(' ')[0])}</h1>
      <p class="muted">${open.length ? `Você tem ${open.length} tarefa${open.length > 1 ? 's' : ''} em aberto${overdue.length ? `, ${overdue.length} atrasada${overdue.length > 1 ? 's' : ''}` : ''}.` : 'Nenhuma tarefa aberta com você agora.'}</p></div>
    <div class="stats">
      <div class="stat"><div class="caption muted">Em aberto</div><div class="v">${open.length}</div></div>
      <div class="stat"><div class="caption muted">Atrasadas</div><div class="v" style="${overdue.length ? 'color:var(--danger)' : ''}">${overdue.length}</div></div>
      <div class="stat"><div class="caption muted">Para hoje</div><div class="v">${due.length}</div></div>
      <div class="stat"><div class="caption muted">Concluídas em 7 dias</div><div class="v">${doneWeek.length}</div></div>
    </div>
    <div class="home-grid">
      <div>
        ${overdue.length ? panel('Atrasadas', overdue, '') : ''}
        ${panel('Hoje', due, 'Nada com prazo para hoje.')}
        ${panel('Próximos 7 dias', upcoming, 'Nenhum prazo nesta semana.')}
        ${nodate.length ? panel('Sem prazo', nodate, '') : ''}
      </div>
      <div>
        <div class="panel"><div class="panel-head"><h3 class="h-card">Espaços</h3><button class="btn btn-text btn-sm" data-act="new-space">${icon('plus', 'sm')}Novo</button></div>
          ${spaces.length ? spaces.map(({ s, total, done }) => `<a class="mini-task" href="#/espaco/${s.id}/${store.get('view:' + s.id, 'lista')}">
            <span class="space-chip" style="background:${esc(s.color)}">${esc(initials(s.name)[0])}</span><span class="t" style="color:var(--text)">${esc(s.name)}</span>
            <span class="where">${done}/${total}</span><span style="width:80px" class="progress"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></span></a>`).join('')
            : `<p class="faint caption" style="margin:0">Crie um espaço para cada cliente, área ou projeto.</p><button class="btn btn-primary btn-sm" style="margin-top:12px" data-act="new-space">Criar espaço</button>`}
        </div>
      </div>
    </div>
  </div>`;
}

async function inboxView(c) {
  let items;
  try { items = await api('GET', '/api/notifications'); } catch (e) { fail(e); return; }
  if (S.route.name !== 'entrada') return;
  const onlyUnread = store.get('inboxUnread', false);
  const shown = onlyUnread ? items.filter((n) => !n.read) : items;
  c.innerHTML = `<div class="page-narrow" style="max-width:820px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;flex-wrap:wrap"><h1 class="h-display" style="flex:1">Caixa de entrada</h1>
      <div class="tabs"><button class="tab ${onlyUnread ? '' : 'on'}" data-act="inbox-filter" data-v="0">Todas</button><button class="tab ${onlyUnread ? 'on' : ''}" data-act="inbox-filter" data-v="1">Não lidas</button></div>
      <button class="btn btn-ghost btn-sm" data-act="read-all" ${items.some((n) => !n.read) ? '' : 'disabled'}>Marcar todas como lidas</button></div>
    ${shown.length ? shown.map((n) => {
      const a = userById(n.actor_id);
      return `<div class="notif ${n.read ? '' : 'unread'}" data-notif="${n.id}" data-task-id="${esc(n.task_id || '')}">${avatar(a, 'md')}
        <div class="body"><div><b style="font-weight:480">${esc(a?.name || 'Alguém')}</b> <span class="muted">${esc(n.text)}</span></div></div>
        <span class="when">${timeAgo(n.created_at)}</span></div>`;
    }).join('') : `<div class="empty"><div class="h-card">Tudo em dia</div><p>Atribuições, menções e comentários nas suas tarefas aparecem aqui.</p></div>`}
  </div>`;
}

function membersView() {
  const isAdmin = S.me.role === 'admin';
  return `<div class="page-narrow" style="max-width:820px">
    <h1 class="h-display" style="margin-bottom:8px">Equipe</h1>
    <p class="muted" style="margin:0 0 24px">Todos com conta veem os mesmos espaços. Para alguém entrar, basta criar a conta na tela de login${S.config.registrationCode ? ' com o código de convite' : ''}.</p>
    <div class="panel">${S.users.map((u) => `<div class="member" style="${u.active ? '' : 'opacity:.5'}">${avatar(u, 'md')}
      <div class="who"><div>${esc(u.name)}${u.id === S.me.id ? ' <span class="faint">(você)</span>' : ''}</div><div class="caption faint">${esc(u.email)}</div></div>
      <span class="role-badge">${u.role === 'admin' ? 'Administrador' : 'Membro'}${u.active ? '' : ' · desativado'}</span>
      ${isAdmin && u.id !== S.me.id ? `<button class="icon-btn" data-act="member-menu" data-id="${u.id}" aria-label="Opções">${icon('more', 'sm')}</button>` : ''}
    </div>`).join('')}</div>
  </div>`;
}

const SWATCHES = ['#7d8ce0', '#5fae8f', '#c9a55c', '#9b87d9', '#d98a8a', '#6fb3c4', '#b58ac9', '#a3a86b', '#8a9bb0', '#c98f6b'];
function profileView() {
  return `<div class="page-narrow" style="max-width:640px">
    <h1 class="h-display" style="margin-bottom:24px">Seu perfil</h1>
    <form class="panel" data-form="profile" style="display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;align-items:center;gap:16px">${avatar(S.me, 'lg')}<div><div class="h-card">${esc(S.me.name)}</div><div class="caption faint">${esc(S.me.email)}</div></div></div>
      <div class="field"><label for="p-name">Nome</label><input class="input" id="p-name" name="name" value="${esc(S.me.name)}"></div>
      <div class="field"><label>Cor do avatar</label><div class="swatches">${SWATCHES.map((c) => `<button type="button" class="swatch ${c === S.me.color ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="Cor ${c}"></button>`).join('')}</div></div>
      <div><button class="btn btn-primary" type="submit">Salvar</button></div>
    </form>
    <form class="panel" data-form="password" style="display:flex;flex-direction:column;gap:16px">
      <h2 class="h-card">Trocar senha</h2>
      <div class="field"><label for="p-cur">Senha atual</label><input class="input" id="p-cur" name="currentPassword" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="p-new">Nova senha</label><input class="input" id="p-new" name="newPassword" type="password" autocomplete="new-password" minlength="8"></div>
      <div><button class="btn btn-ghost" type="submit">Atualizar senha</button></div>
    </form>
  </div>`;
}
function bindProfile(c) {
  let color = S.me.color;
  c.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => {
    color = b.dataset.color;
    c.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  c.querySelector('[data-form=profile]').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { user } = await api('PATCH', '/api/me', { name: e.target.name.value, color });
      S.me = user; await loadBootstrap(); renderSidebar(); renderContent(); toast('Perfil atualizado');
    } catch (ex) { fail(ex); }
  });
  c.querySelector('[data-form=password]').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', '/api/me', { currentPassword: e.target.currentPassword.value, newPassword: e.target.newPassword.value });
      e.target.reset(); toast('Senha atualizada');
    } catch (ex) { fail(ex); }
  });
}

// ---------- ações ----------
const taskOf = (id) => S.tasks.find((t) => t.id === id);

function newSpaceDialog(space) {
  let color = space?.color || SWATCHES[S.spaces.length % SWATCHES.length];
  dialog(`<h2 class="h-section">${space ? 'Editar espaço' : 'Novo espaço'}</h2>
    <p class="muted" style="margin:0">${space ? '' : 'Um espaço agrupa listas: por exemplo, um cliente, uma campanha ou uma área.'}</p>
    <form style="display:flex;flex-direction:column;gap:16px">
      <div class="field"><label for="s-name">Nome</label><input class="input" id="s-name" name="name" value="${esc(space?.name || '')}" placeholder="Ex.: Cliente Acme" required></div>
      <div class="field"><label>Cor</label><div class="swatches">${SWATCHES.map((c) => `<button type="button" class="swatch ${c === color ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="Cor"></button>`).join('')}</div></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn btn-text" data-close>Cancelar</button><button class="btn btn-primary" type="submit">${space ? 'Salvar' : 'Criar espaço'}</button></div>
    </form>`, (m, close) => {
    m.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => { color = b.dataset.color; m.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === b)); }));
    m.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      if (!name) return;
      try {
        if (space) await api('PATCH', `/api/spaces/${space.id}`, { name, color });
        else { const s = await api('POST', '/api/spaces', { name, color }); await loadBootstrap(); close(); go(`#/espaco/${s.id}/lista`); renderSidebar(); return; }
        await loadBootstrap(); renderSidebar(); renderTop(); close();
      } catch (ex) { fail(ex); }
    });
  });
}

function newFolderDialog(spaceId, folder) {
  dialog(`<h2 class="h-section">${folder ? 'Renomear pasta' : 'Nova pasta'}</h2>
    <p class="muted" style="margin:0">${folder ? '' : 'Pastas agrupam listas dentro de um espaço, por exemplo um job ou uma campanha com várias entregas.'}</p>
    <form style="display:flex;flex-direction:column;gap:16px">
      <div class="field"><label for="fo-name">Nome</label><input class="input" id="fo-name" name="name" value="${esc(folder?.name || '')}" placeholder="Ex.: Campanha de Verão" required></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn btn-text" data-close>Cancelar</button><button class="btn btn-primary" type="submit">${folder ? 'Salvar' : 'Criar pasta'}</button></div>
    </form>`, (m, close) => {
    m.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      if (!name) return;
      try {
        if (folder) await api('PATCH', `/api/folders/${folder.id}`, { name });
        else { const f = await api('POST', '/api/folders', { space_id: spaceId, name }); collapsedSpaces.delete(spaceId); await loadBootstrap(); close(); newListDialog(spaceId, null, f.id); renderSidebar(); return; }
        await loadBootstrap(); renderSidebar(); renderTop(); close();
      } catch (ex) { fail(ex); }
    });
  });
}

function newListDialog(spaceId, list, folderId = null) {
  dialog(`<h2 class="h-section">${list ? 'Renomear lista' : 'Nova lista'}</h2>
    <form style="display:flex;flex-direction:column;gap:16px">
      <div class="field"><label for="l-name">Nome</label><input class="input" id="l-name" name="name" value="${esc(list?.name || '')}" placeholder="Ex.: Social media, Campanha de Natal" required></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn btn-text" data-close>Cancelar</button><button class="btn btn-primary" type="submit">${list ? 'Salvar' : 'Criar lista'}</button></div>
    </form>`, (m, close) => {
    m.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      if (!name) return;
      try {
        if (list) { await api('PATCH', `/api/lists/${list.id}`, { name }); await loadBootstrap(); renderSidebar(); renderTop(); close(); return; }
        const l = await api('POST', '/api/lists', { space_id: spaceId, name, folder_id: folderId });
        collapsedSpaces.delete(spaceId);
        if (folderId) collapsedSpaces.delete(folderId);
        await loadBootstrap(); close(); go(`#/lista/${l.id}/lista`);
      } catch (ex) { fail(ex); }
    });
  });
}

function statusesDialog(list) {
  let sts = list.statuses.map((s) => ({ ...s }));
  dialog(`<h2 class="h-section">Status de “${esc(list.name)}”</h2>
    <p class="muted caption" style="margin:0">Defina as etapas do fluxo. Tarefas em um status removido voltam para o primeiro.</p>
    <div data-sts></div>
    <button class="btn btn-text btn-sm" style="align-self:flex-start" data-add>${icon('plus', 'sm')}Adicionar status</button>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-text" data-close>Cancelar</button><button class="btn btn-primary" data-save>Salvar</button></div>`, (m, close) => {
    const box = m.querySelector('[data-sts]');
    const draw = () => {
      box.innerHTML = sts.map((s, i) => `<div class="status-edit" data-i="${i}">
        <input type="color" value="${esc(s.color)}" data-k="color" aria-label="Cor">
        <input class="input" value="${esc(s.name)}" data-k="name" aria-label="Nome">
        <select class="select" data-k="type" aria-label="Tipo"><option value="open" ${s.type === 'open' ? 'selected' : ''}>Não iniciado</option><option value="active" ${s.type === 'active' ? 'selected' : ''}>Em andamento</option><option value="done" ${s.type === 'done' ? 'selected' : ''}>Concluído</option></select>
        <button class="icon-btn" data-up aria-label="Subir">${icon('chevron', 'sm')}</button>
        <button class="icon-btn" data-del aria-label="Remover">${icon('trash', 'sm')}</button></div>`).join('');
    };
    draw();
    box.addEventListener('input', (e) => { const row = e.target.closest('[data-i]'); if (row) sts[row.dataset.i][e.target.dataset.k] = e.target.value; });
    box.addEventListener('change', (e) => { const row = e.target.closest('[data-i]'); if (row) sts[row.dataset.i][e.target.dataset.k] = e.target.value; });
    box.addEventListener('click', (e) => {
      const row = e.target.closest('[data-i]'); if (!row) return;
      const i = +row.dataset.i;
      if (e.target.closest('[data-del]')) { if (sts.length > 1) sts.splice(i, 1); draw(); }
      if (e.target.closest('[data-up]') && i > 0) { [sts[i - 1], sts[i]] = [sts[i], sts[i - 1]]; draw(); }
    });
    m.querySelector('[data-add]').addEventListener('click', () => { sts.splice(sts.length - 1, 0, { id: 's' + Date.now().toString(36), name: 'Novo status', color: '#8a9bb0', type: 'active' }); draw(); });
    m.querySelector('[data-save]').addEventListener('click', async () => {
      try { await api('PATCH', `/api/lists/${list.id}`, { statuses: sts }); await loadBootstrap(); await loadTasks(); renderContent(); close(); toast('Status atualizados'); } catch (ex) { fail(ex); }
    });
  });
}

export function newTaskDialog(preset = {}) {
  const def = preset.list_id ? listById(preset.list_id) : defaultListForView() || S.lists[0];
  if (!def) { toast('Crie um espaço e uma lista primeiro'); newSpaceDialog(); return; }
  const opts = S.spaces.map((s) => {
    const ls = S.lists.filter((l) => l.space_id === s.id);
    return ls.length ? `<optgroup label="${esc(s.name)}">${ls.map((l) => `<option value="${l.id}" ${l.id === def.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  dialog(`<h2 class="h-section">Nova tarefa</h2>
    <form style="display:flex;flex-direction:column;gap:16px">
      <div class="field"><label for="t-title">Título</label><input class="input" id="t-title" name="title" required placeholder="Ex.: Key visual da campanha"></div>
      <div class="field"><label for="t-list">Lista</label><select class="select input" id="t-list" name="list_id">${opts}</select></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="field"><label for="t-due">Prazo</label><input class="input" id="t-due" name="due_date" type="date" style="color-scheme:dark" value="${esc(preset.due_date || '')}"></div>
        <div class="field"><label for="t-prio">Prioridade</label><select class="select input" id="t-prio" name="priority"><option value="">Sem prioridade</option>${Object.entries(PRIORITY).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('')}</select></div>
      </div>
      <label style="display:flex;gap:10px;align-items:center" class="muted"><input type="checkbox" class="check" name="mine" ${S.route.name === 'minhas' || preset.mine ? 'checked' : ''}> Atribuir a mim</label>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn btn-text" data-close>Cancelar</button><button class="btn btn-primary" type="submit">Criar tarefa</button></div>
    </form>`, (m, close) => {
    m.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (!f.title.value.trim()) return;
      try {
        const t = await createTask({ title: f.title.value, list_id: f.list_id.value, due_date: f.due_date.value || null, priority: f.priority.value || null, assignees: f.mine.checked ? [S.me.id] : [], status: preset.status });
        close();
        go(taskHash(t.id));
      } catch (ex) { fail(ex); }
    });
  });
}

export function taskMenu(anchor, task, { inModal = false } = {}) {
  menuPopover(anchor, {
    items: () => [
      { id: 'open', text: 'abrir', html: `${icon('eye', 'sm')}Abrir` },
      { id: 'copy', text: 'copiar', html: `${icon('link', 'sm')}Copiar link` },
      { id: 'move', text: 'mover', html: `${icon('move', 'sm')}Mover para outra lista` },
      { id: 'archive', text: 'arquivar', html: `${icon('archive', 'sm')}Arquivar` },
      { sep: true },
      { id: 'delete', text: 'excluir', danger: true, html: `${icon('trash', 'sm')}Excluir` },
    ].filter((x) => !(inModal && x.id === 'open')),
    onPick: async (id) => {
      if (id === 'open') go(taskHash(task.id));
      if (id === 'copy') { await navigator.clipboard?.writeText(location.origin + '/' + routeHash() + '?tarefa=' + task.id).catch(() => {}); toast('Link copiado'); }
      if (id === 'move') setTimeout(() => moveTaskPopover(anchor, task), 0);
      if (id === 'archive') {
        await patchTask(task.id, { archived: true });
        S.tasks = S.tasks.filter((t) => t.id !== task.id); renderContent();
        if (inModal) closeTask();
        toast('Tarefa arquivada', { action: 'Desfazer', onAction: async () => { await api('PATCH', `/api/tasks/${task.id}`, { archived: false }); await loadTasks(); renderContent(); } });
      }
      if (id === 'delete') {
        if (!(await confirmDialog('Excluir tarefa?', `“${task.title}” e suas subtarefas, comentários e anexos serão apagados para sempre.`, { ok: 'Excluir', danger: true }))) return;
        try { await api('DELETE', `/api/tasks/${task.id}`); S.tasks = S.tasks.filter((t) => t.id !== task.id && t.parent_id !== task.id); renderContent(); if (inModal) closeTask(); toast('Tarefa excluída'); } catch (e) { fail(e); }
      }
    },
  });
}
function moveTaskPopover(anchor, task) {
  menuPopover(anchor, {
    search: true, width: 280,
    items: () => S.spaces.flatMap((s) => {
      const ls = S.lists.filter((l) => l.space_id === s.id);
      return ls.length ? [{ label: s.name }, ...ls.map((l) => ({ id: l.id, text: s.name + ' ' + l.name, selected: l.id === task.list_id, html: `<span class="dot" style="color:${esc(s.color)}"></span>${esc(l.name)}` }))] : [];
    }),
    onPick: async (id) => {
      if (id === task.list_id) return;
      await patchTask(task.id, { list_id: id });
      const r = S.route;
      if (r.name === 'lista' && r.id !== id) { S.tasks = S.tasks.filter((t) => t.id !== task.id); renderContent(); }
      toast('Tarefa movida para ' + listById(id).name);
    },
  });
}

function openPalette() {
  if (document.querySelector('.palette')) return;
  const wrap = document.createElement('div');
  wrap.className = 'palette';
  wrap.innerHTML = `<div class="palette-box" role="dialog" aria-label="Buscar"><input class="input" placeholder="Buscar tarefas, listas e espaços…" aria-label="Buscar"><div class="palette-results"></div></div>`;
  document.body.append(wrap);
  const input = wrap.querySelector('input'), res = wrap.querySelector('.palette-results');
  let items = [], active = 0, seq = 0;
  const close = () => wrap.remove();
  const draw = () => {
    res.innerHTML = items.length ? items.map((it, i) => `<a class="menu-item ${i === active ? 'active' : ''}" href="${it.href}" data-i="${i}">${it.html}</a>`).join('')
      : `<div class="empty" style="padding:24px">${input.value ? 'Nada encontrado' : 'Digite para buscar'}</div>`;
  };
  const search = async () => {
    const q = input.value.trim().toLowerCase();
    const my = ++seq;
    const local = [
      ...S.spaces.filter((s) => !q || s.name.toLowerCase().includes(q)).map((s) => ({ href: `#/espaco/${s.id}/lista`, html: `<span class="space-chip" style="background:${esc(s.color)}">${esc(initials(s.name)[0])}</span>${esc(s.name)}<span class="faint caption" style="margin-left:auto">Espaço</span>` })),
      ...S.lists.filter((l) => !q || l.name.toLowerCase().includes(q)).map((l) => ({ href: `#/lista/${l.id}/lista`, html: `${icon('list', 'sm')}${esc(l.name)}<span class="faint caption" style="margin-left:auto">${esc(spaceById(l.space_id)?.name || '')}</span>` })),
    ].slice(0, q ? 6 : 8);
    items = local; active = 0; draw();
    if (!q) return;
    try {
      const tasks = await api('GET', '/api/tasks?limit=30&q=' + encodeURIComponent(q));
      if (my !== seq) return;
      items = [...tasks.map((t) => ({ href: routeHash() + '?tarefa=' + t.id, html: `${statusPill(statusOf(t))}<span class="ellipsis">${esc(t.title)}</span><span class="faint caption" style="margin-left:auto;white-space:nowrap">${esc(listById(t.list_id)?.name || '')}</span>` })), ...local];
      draw();
    } catch { /* ignora */ }
  };
  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 150); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    if (e.key === 'Enter' && items[active]) { location.hash = items[active].href; close(); }
  });
  res.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  input.focus();
  search();
}

const ACTIONS = {
  nav: () => document.querySelector('.app').classList.toggle('nav-open'),
  palette: openPalette,
  'new-space': () => newSpaceDialog(),
  'new-list': (el) => newListDialog(el.dataset.id, null, el.dataset.folder || null),
  'new-in-space': (el) => menuPopover(el, {
    items: () => [{ id: 'list', html: `${icon('list', 'sm')}Nova lista` }, { id: 'folder', html: `${icon('folder', 'sm')}Nova pasta` }],
    onPick: (id) => (id === 'list' ? newListDialog(el.dataset.id) : newFolderDialog(el.dataset.id)),
  }),
  'folder-menu': (el) => {
    const f = folderById(el.dataset.id);
    menuPopover(el, {
      items: () => [
        { id: 'new-list', html: `${icon('plus', 'sm')}Nova lista na pasta` },
        { id: 'rename', html: `${icon('edit', 'sm')}Renomear` },
        { sep: true },
        { id: 'delete', danger: true, html: `${icon('trash', 'sm')}Excluir pasta` },
      ],
      onPick: async (id) => {
        if (id === 'new-list') newListDialog(f.space_id, null, f.id);
        if (id === 'rename') newFolderDialog(f.space_id, f);
        if (id === 'delete' && await confirmDialog('Excluir pasta?', `As listas de “${f.name}” não serão apagadas: elas voltam para a raiz do espaço.`, { ok: 'Excluir pasta', danger: true })) {
          try { await api('DELETE', `/api/folders/${f.id}`); await loadBootstrap(); if (S.route.id === f.id) go('#/espaco/' + f.space_id + '/lista'); renderSidebar(); } catch (e) { fail(e); }
        }
      },
    });
  },
  group: (el) => menuPopover(el, {
    items: () => Object.entries(GROUPS).map(([k, v]) => ({ id: k, selected: S.filters.group === k, html: v })),
    onPick: (id) => { S.filters.group = id; store.set('group:' + (S.route.id || S.route.name), id); renderTop(); renderContent(); },
  }),
  select: (el) => {
    const id = el.dataset.id;
    S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
    renderContent();
  },
  'select-group': (el) => {
    const ids = el.dataset.ids.split(',');
    const all = ids.every((i) => S.selected.has(i));
    for (const i of ids) all ? S.selected.delete(i) : S.selected.add(i);
    renderContent();
  },
  'timer-stop': async () => {
    try { await api('POST', '/api/timer/stop'); S.timer = null; renderSidebar(); await loadTasks(); renderContent(); if (currentTaskId()) refreshTask(); toast('Tempo registrado'); } catch (e) { fail(e); }
  },
  'tl-prev': () => { S.tlStart = addDays(tlStartDate(), -7); renderContent(); },
  'tl-next': () => { S.tlStart = addDays(tlStartDate(), 7); renderContent(); },
  'tl-today': () => { S.tlStart = null; S.tlScroll = 0; renderContent(); },
  'wl-cell': (el) => {
    const t0 = today(), last = addDays(t0, 6), key = el.dataset.key, uidv = el.dataset.user;
    const list = S.tasks.filter((t) => !t.archived && !isDone(t) && (uidv === '__none' ? !t.assignees.length : t.assignees.includes(uidv))
      && (key === 'late' ? t.due_date && t.due_date < t0 : key === 'none' ? !t.due_date : key === 'later' ? t.due_date > last : t.due_date === key));
    menuPopover(el, { width: 300, items: () => list.map((t) => ({ id: t.id, html: `${statusPill(statusOf(t))}<span class="ellipsis">${esc(t.title)}</span>${t.time_estimate ? `<span class="faint caption" style="margin-left:auto">${fmtMinutes(t.time_estimate)}</span>` : ''}` })), onPick: (id) => go(taskHash(id)) });
  },
  'new-task': () => newTaskDialog(),
  'toggle-space': (el) => {
    const id = el.dataset.id;
    collapsedSpaces.has(id) ? collapsedSpaces.delete(id) : collapsedSpaces.add(id);
    store.set('collapsedSpaces', [...collapsedSpaces]);
    el.closest('.folder, .space').classList.toggle('collapsed');
  },
  'toggle-group': (el) => {
    const k = el.dataset.key;
    collapsedGroups.has(k) ? collapsedGroups.delete(k) : collapsedGroups.add(k);
    el.closest('.group').classList.toggle('collapsed');
  },
  'space-menu': (el) => {
    const s = spaceById(el.dataset.id);
    menuPopover(el, {
      items: () => [
        { id: 'new-list', text: '', html: `${icon('plus', 'sm')}Nova lista` },
        { id: 'new-folder', text: '', html: `${icon('folder', 'sm')}Nova pasta` },
        { id: 'edit', text: '', html: `${icon('edit', 'sm')}Editar espaço` },
        ...(S.me.role === 'admin' ? [{ sep: true }, { id: 'delete', danger: true, html: `${icon('trash', 'sm')}Excluir espaço` }] : []),
      ],
      onPick: async (id) => {
        if (id === 'new-list') newListDialog(s.id);
        if (id === 'new-folder') newFolderDialog(s.id);
        if (id === 'edit') newSpaceDialog(s);
        if (id === 'delete' && await confirmDialog('Excluir espaço?', `“${s.name}” e todas as suas listas deixarão de aparecer para a equipe.`, { ok: 'Excluir', danger: true })) {
          try { await api('DELETE', `/api/spaces/${s.id}`); await loadBootstrap(); if (S.route.id === s.id || listById(S.route.id) === undefined) go('#/inicio'); renderSidebar(); renderContent(); } catch (e) { fail(e); }
        }
      },
    });
  },
  'list-menu': (el) => {
    const l = listById(el.dataset.id);
    const fav = S.favorites.includes(l.id);
    menuPopover(el, {
      items: () => [
        { id: 'fav', html: `${icon('star', 'sm')}${fav ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}` },
        { id: 'rename', html: `${icon('edit', 'sm')}Renomear` },
        { id: 'statuses', html: `${icon('settings', 'sm')}Editar status` },
        { id: 'folder', html: `${icon('folder', 'sm')}Mover para pasta` },
        { sep: true },
        { id: 'delete', danger: true, html: `${icon('trash', 'sm')}Excluir lista` },
      ],
      onPick: async (id) => {
        if (id === 'fav') ACTIONS.fav({ dataset: { id: l.id } });
        if (id === 'rename') newListDialog(l.space_id, l);
        if (id === 'statuses') statusesDialog(l);
        if (id === 'folder') setTimeout(() => menuPopover(el, {
          items: () => [...S.folders.filter((f) => f.space_id === l.space_id).map((f) => ({ id: f.id, selected: l.folder_id === f.id, html: `${icon('folder', 'sm')}${esc(f.name)}` })),
            { sep: true }, { id: '__root', selected: !l.folder_id, html: '<span class="muted">Fora de pastas</span>' }, { id: '__new', html: `${icon('plus', 'sm')}Nova pasta` }],
          onPick: async (fid) => {
            if (fid === '__new') return newFolderDialog(l.space_id);
            try { await api('PATCH', `/api/lists/${l.id}`, { folder_id: fid === '__root' ? null : fid }); await loadBootstrap(); renderSidebar(); } catch (e) { fail(e); }
          },
        }), 0);
        if (id === 'delete' && await confirmDialog('Excluir lista?', `“${l.name}” e suas tarefas deixarão de aparecer.`, { ok: 'Excluir', danger: true })) {
          try { await api('DELETE', `/api/lists/${l.id}`); await loadBootstrap(); if (S.route.id === l.id) go('#/inicio'); renderSidebar(); } catch (e) { fail(e); }
        }
      },
    });
  },
  fav: async (el) => {
    try {
      const { favorite } = await api('POST', `/api/lists/${el.dataset.id}/favorite`);
      S.favorites = favorite ? [...S.favorites, el.dataset.id] : S.favorites.filter((x) => x !== el.dataset.id);
      renderSidebar(); renderTop();
    } catch (e) { fail(e); }
  },
  'me-menu': (el) => menuPopover(el, {
    items: () => [
      { id: 'profile', html: `${icon('user', 'sm')}Meu perfil` },
      { id: 'team', html: `${icon('users', 'sm')}Equipe` },
      { sep: true },
      { id: 'logout', html: `${icon('logout', 'sm')}Sair` },
    ],
    onPick: async (id) => {
      if (id === 'profile') go('#/perfil');
      if (id === 'team') go('#/membros');
      if (id === 'logout') { await api('POST', '/api/auth/logout').catch(() => {}); location.hash = ''; location.reload(); }
    },
  }),
  'member-menu': (el) => {
    const u = userById(el.dataset.id);
    menuPopover(el, {
      items: () => [
        { id: 'role', html: u.role === 'admin' ? 'Tornar membro' : 'Tornar administrador' },
        { id: 'active', danger: u.active, html: u.active ? 'Desativar acesso' : 'Reativar acesso' },
      ],
      onPick: async (id) => {
        try {
          if (id === 'role') await api('PATCH', `/api/users/${u.id}`, { role: u.role === 'admin' ? 'member' : 'admin' });
          if (id === 'active') await api('PATCH', `/api/users/${u.id}`, { active: !u.active });
          await loadBootstrap(); renderContent();
        } catch (e) { fail(e); }
      },
    });
  },
  'toggle-done-task': (el) => { const t = taskOf(el.dataset.id); if (t) toggleDone(t).catch(() => {}); },
  status: (el) => { const t = taskOf(el.dataset.id); if (t) pickStatus(el, t); },
  priority: (el) => { const t = taskOf(el.dataset.id); if (t) pickPriority(el, t); },
  assignees: (el) => { const t = taskOf(el.dataset.id); if (t) pickAssignees(el, t); },
  'task-menu': (el) => { const t = taskOf(el.dataset.id); if (t) taskMenu(el, t); },
  'filter-assignee': (el) => menuPopover(el, {
    search: true, multi: true,
    items: () => [{ id: S.me.id, text: 'eu ' + S.me.name, selected: S.filters.assignees.includes(S.me.id), html: `${avatar(S.me)}Eu` },
      ...S.users.filter((u) => u.id !== S.me.id && u.active).map((u) => ({ id: u.id, text: u.name, selected: S.filters.assignees.includes(u.id), html: `${avatar(u)}<span class="ellipsis">${esc(u.name)}</span>` })),
      { id: '__none', text: 'sem responsável', selected: S.filters.assignees.includes('__none'), html: `<span class="avatar-empty">${icon('user', 'sm')}</span>Sem responsável` }],
    onPick: (id) => { const a = S.filters.assignees; S.filters.assignees = a.includes(id) ? a.filter((x) => x !== id) : [...a, id]; renderTop(); renderContent(); },
  }),
  'filter-priority': (el) => menuPopover(el, {
    multi: true,
    items: () => [...Object.entries(PRIORITY).map(([k]) => ({ id: k, selected: S.filters.priorities.includes(k), html: prioHtml(k) })),
      { id: '__none', selected: S.filters.priorities.includes('__none'), html: '<span class="muted">Sem prioridade</span>' }],
    onPick: (id) => { const a = S.filters.priorities; S.filters.priorities = a.includes(id) ? a.filter((x) => x !== id) : [...a, id]; renderTop(); renderContent(); },
  }),
  sort: (el) => menuPopover(el, {
    items: () => Object.entries({ manual: 'Ordem manual', due: 'Prazo', priority: 'Prioridade', title: 'Nome', created: 'Mais recentes' }).map(([k, v]) => ({ id: k, selected: S.filters.sort === k, html: v })),
    onPick: (id) => { S.filters.sort = id; renderTop(); renderContent(); },
  }),
  'toggle-done': () => { S.filters.showDone = !S.filters.showDone; renderTop(); renderContent(); },
  'cal-prev': () => { S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() - 1, 1); renderContent(); },
  'cal-next': () => { S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() + 1, 1); renderContent(); },
  'cal-today': () => { const d = new Date(); S.calMonth = new Date(d.getFullYear(), d.getMonth(), 1); renderContent(); },
  'cal-add': (el) => {
    const date = el.dataset.date;
    const list = S.route.name === 'minhas' ? null : defaultListForView();
    if (!list) { newTaskDialog({ due_date: date, mine: true }); return; }
    openPopover(el, (p) => {
      p.innerHTML = `<div class="pop-search"><input class="input input-sm" placeholder="Nova tarefa em ${esc(fmtDate(date))}"></div>`;
      const inp = p.querySelector('input');
      inp.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter' || !inp.value.trim()) return;
        try { await createTask({ title: inp.value, list_id: list.id, due_date: date }); closePopover(); } catch (ex) { fail(ex); }
      });
    }, { width: 260 });
  },
  'cal-more': (el) => {
    const date = el.dataset.date;
    const list = filtered(S.tasks).filter((t) => t.due_date === date);
    menuPopover(el, { items: () => list.map((t) => ({ id: t.id, html: `${statusPill(statusOf(t))}<span class="ellipsis">${esc(t.title)}</span>` })), onPick: (id) => go(taskHash(id)) });
  },
  'inbox-filter': (el) => { store.set('inboxUnread', el.dataset.v === '1'); renderContent(); },
  'read-all': async () => { await api('POST', '/api/notifications/read', {}); S.unread = 0; renderSidebar(); renderContent(); },
};

function bindGlobal() {
  document.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act && document.getElementById('root').contains(act)) {
      if (act.tagName !== 'INPUT') e.preventDefault();
      ACTIONS[act.dataset.act]?.(act, e);
      return;
    }
    const n = e.target.closest('[data-notif]');
    if (n) {
      api('POST', '/api/notifications/read', { id: n.dataset.notif }).then(() => { S.unread = Math.max(0, S.unread - (n.classList.contains('unread') ? 1 : 0)); renderSidebar(); n.classList.remove('unread'); }).catch(() => {});
      if (n.dataset.taskId) go('#/entrada?tarefa=' + n.dataset.taskId);
      return;
    }
    if (e.target.closest('[data-stop], a, input, button, label')) return;
    const t = e.target.closest('[data-task]');
    if (t && document.querySelector('.content')?.contains(t)) go(taskHash(t.dataset.task));
  });
  document.addEventListener('change', (e) => {
    const d = e.target.closest('.content [data-date-field]');
    if (d) patchTask(d.dataset.id, { [d.dataset.dateField]: d.value || null }).catch(() => {});
  });
  document.addEventListener('input', (e) => {
    if (e.target.matches('[data-filter-q]')) { S.filters.q = e.target.value; renderContent(); }
  });
  document.addEventListener('keydown', async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    const qa = e.target.closest?.('[data-quick-add]');
    if (qa && e.key === 'Enter' && qa.value.trim()) {
      let preset = {};
      try { preset = JSON.parse(qa.dataset.quickAdd); } catch { preset = { status: qa.dataset.quickAdd }; }
      const list = (preset.list_id && listById(preset.list_id)) || defaultListForView();
      if (!list) return;
      const title = qa.value; qa.value = '';
      if (preset.status && !list.statuses.some((s) => s.id === preset.status)) delete preset.status;
      try {
        await createTask({ ...preset, title, list_id: list.id });
        document.querySelector(`[data-quick-add="${CSS.escape(qa.dataset.quickAdd)}"]`)?.focus();
      } catch (ex) { fail(ex); qa.value = title; }
    }
    if (qa && e.key === 'Escape') { qa.value = ''; qa.blur(); }
  });
  // Atalhos de teclado para o seletor de data: clicar no rótulo abre o calendário nativo
  document.addEventListener('click', (e) => {
    const lbl = e.target.closest('.content label.cell-btn');
    const inp = lbl?.querySelector('input[type=date]');
    if (inp) { e.preventDefault(); try { inp.showPicker(); } catch { inp.focus(); } }
  });
  bindDnd();
  bindDrawer();
  bindTimeline();
}

// ---------- arrastar e soltar ----------
function bindDnd() {
  let dragId = null, grab = { x: 0, y: 0 };
  const clear = () => document.querySelectorAll('.drop, .drop-before').forEach((x) => x.classList.remove('drop', 'drop-before'));
  document.addEventListener('dragstart', (e) => {
    const el = e.target.closest?.('[data-drag]');
    if (!el) return;
    dragId = el.dataset.drag;
    const r = el.getBoundingClientRect();
    grab = { x: e.clientX - r.left, y: e.clientY - r.top }; // respeita o ponto onde a pessoa pegou
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  document.addEventListener('dragend', (e) => { e.target.closest?.('[data-drag]')?.classList.remove('dragging'); clear(); dragId = null; });
  document.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const zone = e.target.closest('[data-drop-status], [data-drop-date]');
    if (!zone) return;
    e.preventDefault();
    clear();
    zone.classList.add('drop');
    const over = e.target.closest('[data-drag]');
    if (over && over.dataset.drag !== dragId && zone.dataset.dropStatus) {
      const r = over.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const target = after ? over.nextElementSibling?.matches('[data-drag]') ? over.nextElementSibling : null : over;
      if (target) target.classList.add('drop-before');
      zone.dataset.before = target ? target.dataset.drag : '';
    } else if (zone.dataset.dropStatus && !over) zone.dataset.before = '';
  });
  document.addEventListener('drop', async (e) => {
    const zone = e.target.closest('[data-drop-status], [data-drop-date]');
    if (!zone || !dragId) return;
    e.preventDefault();
    const task = taskOf(dragId);
    clear();
    if (!task) return;
    landing = { id: task.id, x: e.clientX - grab.x, y: e.clientY - grab.y, t: performance.now() };
    document.querySelector(`.content [data-drag="${CSS.escape(task.id)}"]`)?.classList.remove('dragging');
    if (zone.dataset.dropDate) {
      if (task.due_date !== zone.dataset.dropDate) patchTask(task.id, { due_date: zone.dataset.dropDate }).catch(() => {});
      return;
    }
    let status = zone.dataset.dropStatus;
    const l = listById(task.list_id);
    if (!l.statuses.some((s) => s.id === status)) {
      const name = viewStatuses(S.tasks).find((s) => s.id === status)?.name;
      const match = l.statuses.find((s) => s.name.toLowerCase() === name?.toLowerCase());
      if (!match) { toast(`A lista “${l.name}” não tem o status “${name}”`, { error: true }); return; }
      status = match.id;
    }
    const patch = {};
    if (status !== task.status) patch.status = status;
    if (S.filters.sort === 'manual') {
      const col = filtered(S.tasks).filter((t) => t.status === zone.dataset.dropStatus && t.id !== task.id);
      const beforeId = zone.dataset.before;
      const idx = beforeId ? col.findIndex((t) => t.id === beforeId) : col.length;
      const prev = col[idx - 1], next = col[idx];
      const pos = prev && next ? (prev.position + next.position) / 2 : prev ? prev.position + 1000 : next ? next.position - 1000 : 1000;
      if (pos !== task.position) patch.position = pos;
    }
    if (Object.keys(patch).length) patchTask(task.id, patch).catch(() => {});
    else applyLanding();
  });
}

// ---------- gaveta do menu no celular: arraste 1:1, impulso e borda elástica ----------
function bindDrawer() {
  const project = (v, d = 0.998) => ((v / 1000) * d) / (1 - d); // projeção de impulso (px/s → px)
  const rubber = (x, dim, c = 0.55) => (x * dim * c) / (dim + c * Math.abs(x));
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    if (innerWidth > 860 || e.pointerType === 'mouse' && e.button !== 0) return;
    const app = document.querySelector('.app'); const side = document.querySelector('.sidebar');
    if (!app || !side) return;
    const open = app.classList.contains('nav-open');
    const fromEdge = !open && e.clientX < 20;
    const onDrawer = open && (side.contains(e.target) || e.target === app);
    if (!fromEdge && !onDrawer) return;
    drag = { x0: e.clientX, y0: e.clientY, open, w: side.offsetWidth, hist: [{ x: e.clientX, t: e.timeStamp }], active: false, side, app, id: e.pointerId };
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.active) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return; // histerese antes de decidir a direção
      if (Math.abs(dy) > Math.abs(dx)) { drag = null; return; } // era rolagem vertical
      drag.active = true;
      drag.side.classList.add('dragging-nav');
      drag.app.classList.add('nav-open');
    }
    drag.hist.push({ x: e.clientX, t: e.timeStamp });
    if (drag.hist.length > 6) drag.hist.shift();
    let pos = (drag.open ? 0 : -drag.w) + dx;
    if (pos > 0) pos = rubber(pos, drag.w); // além do limite, resiste
    pos = Math.max(-drag.w, pos);
    drag.pos = pos;
    drag.side.style.transform = `translateX(${pos}px)`;
    drag.app.style.setProperty('--scrim', String(Math.max(0, 1 + pos / drag.w)));
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.active) return;
    const h = d.hist, a = h[0], b = h[h.length - 1];
    const v = b.t > a.t ? ((b.x - a.x) / (b.t - a.t)) * 1000 : 0; // px/s
    const projected = (d.pos ?? 0) + project(v);
    const shouldOpen = projected > -d.w / 2;
    d.side.classList.remove('dragging-nav');
    // A transição parte do valor atual na tela, sem salto
    requestAnimationFrame(() => {
      d.side.style.transform = '';
      d.app.style.removeProperty('--scrim');
      d.app.classList.toggle('nav-open', shouldOpen);
    });
    // Um arraste não deve virar clique no link onde o dedo terminou
    suppressClickUntil = performance.now() + 350;
  };
  let suppressClickUntil = 0;
  document.addEventListener('click', (ev) => { if (performance.now() < suppressClickUntil) { ev.stopPropagation(); ev.preventDefault(); } }, true);
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  // Tocar no fundo escurecido fecha a gaveta
  document.addEventListener('click', (e) => { const app = document.querySelector('.app'); if (app && e.target === app && app.classList.contains('nav-open')) app.classList.remove('nav-open'); });
}

// ---------- tempo real ----------
let es, refreshTimer, structureTimer;
function connectEvents() {
  es?.close();
  es = new EventSource('/api/events');
  es.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.type === 'tasks') {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        if (S.route.name === 'entrada' || S.route.name === 'membros' || S.route.name === 'perfil') { /* nada */ }
        else if (document.querySelector('.tl-bar.dragging')) { /* não interrompe um arraste */ }
        else if (!document.querySelector('.content [data-quick-add]:focus, .content [data-filter-q]:focus, .dragging')) { try { await loadTasks(); renderContent(); } catch { /* offline */ } }
        if (ev.task_id && currentTaskId() && !taskIsBusy()) refreshTask();
      }, 350);
    }
    if (ev.type === 'structure' || ev.type === 'users') {
      clearTimeout(structureTimer);
      structureTimer = setTimeout(async () => { try { await loadBootstrap(); renderSidebar(); renderTop(); if (S.route.name === 'membros') renderContent(); } catch { /* offline */ } }, 300);
    }
    if (ev.type === 'notification' && ev.users.includes(S.me?.id)) {
      api('GET', '/api/bootstrap').then((b) => { S.unread = b.unread; renderSidebar(); if (S.route.name === 'entrada') renderContent(); }).catch(() => {});
    }
  };
}

// ---------- inicialização ----------
async function boot() {
  try { S.config = await api('GET', '/api/config'); } catch { S.config = {}; }
  try { await loadBootstrap(); } catch (e) {
    if (e.status === 401) { renderAuth(); return; }
    document.getElementById('root').innerHTML = `<div class="empty"><div class="h-card">Não foi possível conectar</div><p>${esc(e.message)}</p></div>`;
    return;
  }
  S.shellRendered = false;
  document.getElementById('root').innerHTML = '';
  if (!bootedOnce) { bindGlobal(); bootedOnce = true; }
  connectEvents();
  await onRoute();
}
let bootedOnce = false;
setUnauthorizedHandler(() => { es?.close(); closePopover(); closeTask(false); renderAuth(); });
window.addEventListener('hashchange', () => { if (S.me) onRoute(); });
void popoverOpen;
boot();
