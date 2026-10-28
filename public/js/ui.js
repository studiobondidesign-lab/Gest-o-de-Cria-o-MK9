// Utilidades de interface: escape, ícones, datas, popovers, toasts e chamadas à API.

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1.2-3.5 3.6-5 6.5-5s5.3 1.5 6.5 5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 15c2 .6 3.3 2.2 4 5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r=".8"/><circle cx="3.5" cy="12" r=".8"/><circle cx="3.5" cy="18" r=".8"/>',
  board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  comment: '<path d="M4 5h16v11H9l-5 4z"/>',
  paperclip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/>',
  subtask: '<path d="M6 3v12a3 3 0 0 0 3 3h9"/><path d="m15 15 3 3-3 3"/>',
  checklist: '<path d="m4 7 2 2 4-4M4 16l2 2 4-4M13 7h7M13 17h7"/>',
  star: '<path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
};
export const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ''}</svg>`;

export const PRIORITY = {
  urgent: { label: 'Urgente', color: 'var(--prio-urgent)', rank: 0 },
  high: { label: 'Alta', color: 'var(--prio-high)', rank: 1 },
  normal: { label: 'Normal', color: 'var(--prio-normal)', rank: 2 },
  low: { label: 'Baixa', color: 'var(--prio-low)', rank: 3 },
};

// ---------- datas ----------
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const MONTHS_FULL = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
export const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => ymd(new Date());
export const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
export function fmtDate(s) {
  if (!s) return '';
  const t = today();
  if (s === t) return 'Hoje';
  if (s === addDays(t, 1)) return 'Amanhã';
  if (s === addDays(t, -1)) return 'Ontem';
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? ' ' + y : ''}`;
}
export function dateClass(s, done) {
  if (!s || done) return '';
  const t = today();
  return s < t ? 'overdue' : s === t ? 'today' : '';
}
export function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d`;
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ---------- API ----------
export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
export let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
export async function api(method, url, body, opts = {}) {
  const headers = { 'X-Requested-With': 'mk9' };
  let payload;
  if (body instanceof Blob) { payload = body; headers['Content-Type'] = body.type || 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  Object.assign(headers, opts.headers || {});
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (!res.ok) {
    if (res.status === 401 && !opts.quiet401) onUnauthorized();
    throw new ApiError(res.status, data?.error || 'Algo deu errado');
  }
  return data;
}

// ---------- toast ----------
export function toast(msg, { error = false, action, onAction, timeout = 3500 } = {}) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  const dismiss = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 180); };
  el.className = 'toast' + (error ? ' err' : '');
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn btn-text btn-sm';
    b.textContent = action;
    b.onclick = () => { onAction?.(); dismiss(); };
    el.append(b);
  }
  box.append(el);
  // O tempo pausa enquanto o mouse está em cima ou a aba está escondida
  let left = timeout, started = Date.now(), timer = setTimeout(dismiss, left);
  const pause = () => { clearTimeout(timer); left -= Date.now() - started; };
  const resume = () => { started = Date.now(); clearTimeout(timer); timer = setTimeout(dismiss, Math.max(800, left)); };
  el.addEventListener('mouseenter', pause);
  el.addEventListener('mouseleave', resume);
  const onVis = () => (document.hidden ? pause() : resume());
  document.addEventListener('visibilitychange', onVis);
  setTimeout(() => document.removeEventListener('visibilitychange', onVis), timeout + 60000);
}
export const fail = (e) => toast(e?.message || 'Algo deu errado', { error: true });

// ---------- popover ----------
let currentPop = null;
export function closePopover() {
  if (!currentPop) return;
  const { el, onClose, cleanup } = currentPop;
  currentPop = null;
  cleanup();
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 100);
  onClose?.();
}
export function openPopover(anchor, build, { onClose, width } = {}) {
  closePopover();
  const el = document.createElement('div');
  el.className = 'popover';
  if (width) el.style.minWidth = width + 'px';
  document.body.append(el);
  build(el);
  const r = anchor.getBoundingClientRect();
  const pr = el.getBoundingClientRect();
  let top = r.bottom + 6, left = r.left, above = false;
  if (top + pr.height > innerHeight - 8) { top = Math.max(8, r.top - pr.height - 6); above = true; }
  if (left + pr.width > innerWidth - 8) left = Math.max(8, innerWidth - pr.width - 8);
  el.style.top = top + 'px';
  el.style.left = left + 'px';
  // Cresce a partir do gatilho
  const ox = Math.min(pr.width, Math.max(0, r.left + Math.min(r.width, 40) / 2 - left));
  el.style.setProperty('--origin', `${ox}px ${above ? '100%' : '0'}`);
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  setTimeout(() => document.addEventListener('mousedown', onDown), 0);
  document.addEventListener('keydown', onKey, true);
  currentPop = { el, onClose, cleanup: () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); } };
  el.querySelector('input')?.focus();
  return el;
}
export const popoverOpen = () => !!currentPop;

// Menu de opções com busca opcional; items: [{id, html, selected, danger, sep, label}]
export function menuPopover(anchor, { items, search = false, multi = false, onPick, footer, width }) {
  return openPopover(anchor, (el) => {
    let q = '';
    const draw = () => {
      const list = items().filter((it) => it.sep || it.label || !q || (it.text || '').toLowerCase().includes(q));
      el.querySelector('.pop-items').innerHTML = list.map((it) => it.sep ? '<div class="menu-sep"></div>'
        : it.label ? `<div class="menu-label">${esc(it.label)}</div>`
        : `<button class="menu-item${it.danger ? ' danger' : ''}" data-id="${esc(it.id)}">${it.html}${it.selected ? `<span class="tick">${icon('check', 'sm')}</span>` : ''}</button>`).join('')
        + (footer ? footer(q) : '');
    };
    el.innerHTML = (search ? `<div class="pop-search"><input class="input input-sm" placeholder="Buscar…"></div>` : '') + '<div class="pop-items"></div>';
    const input = el.querySelector('.pop-search input');
    input?.addEventListener('input', () => { q = input.value.trim().toLowerCase(); draw(); });
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { el.querySelector('.pop-items [data-id], .pop-items [data-create]')?.click(); } });
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-id],[data-create]');
      if (!b) return;
      await onPick(b.dataset.id ?? null, b, input ? input.value.trim() : q);
      if (multi) draw(); else closePopover();
    });
    draw();
  }, { width });
}

// ---------- diálogos ----------
export function dialog(html, setup) {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.style.zIndex = 70;
  wrap.style.alignItems = 'center';
  wrap.innerHTML = `<div class="modal modal-sm" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(wrap);
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    wrap.classList.add('leaving');
    setTimeout(() => wrap.remove(), 160);
  };
  const onKey = (e) => { if (e.key === 'Escape' && !popoverOpen()) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  setup?.(wrap.querySelector('.modal'), close);
  wrap.querySelector('input, textarea, select')?.focus();
  return close;
}
export function confirmDialog(title, text, { ok = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const close = dialog(`<h2 class="h-section">${esc(title)}</h2><p class="muted" style="margin:0">${esc(text)}</p>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-text" data-close>Cancelar</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(ok)}</button></div>`, (m, close) => {
      m.querySelector('[data-ok]').addEventListener('click', () => { done = true; close(); resolve(true); });
      m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { if (!done) resolve(false); }));
    });
    void close;
  });
}

export function autosize(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
