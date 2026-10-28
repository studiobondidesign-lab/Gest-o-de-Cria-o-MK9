// Modal de detalhe da tarefa: campos, subtarefas, checklist, anexos, comentários e atividade.
import { esc, icon, PRIORITY, fmtDate, timeAgo, fmtSize, api, toast, fail, autosize, menuPopover, confirmDialog, today } from './ui.js';
import {
  S, go, routeHash, taskHash, userById, listById, spaceById, tagById, statusOf, avatar, avatars, statusPill, prioHtml, tagHtml,
  pickStatus, pickPriority, pickAssignees, pickTags, taskMenu, loadTasks, renderContent, renderSidebar, isDone,
  fmtMinutes, parseDuration, elapsed, loadBootstrap,
} from './app.js';

let state = null; // { id, data, overlay }

export const currentTaskId = () => state?.id || null;
// Evita sobrescrever o que a pessoa está digitando quando chega uma atualização em tempo real
export const taskIsBusy = () => {
  const a = document.activeElement;
  return !!(state && a && state.overlay.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === 'text')));
};

export async function openTask(id) {
  if (!state) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-label="Tarefa"><div class="loading">Carregando…</div></div>';
    document.body.append(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeTask(); });
    state = { id, data: null, overlay };
    bind(overlay);
    document.addEventListener('keydown', onKey);
  }
  state.id = id;
  await refreshTask();
}

function onKey(e) {
  if (e.key === 'Escape' && state && !document.querySelector('.popover, .modal-sm, .palette')) {
    if (document.activeElement && state.overlay.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') { document.activeElement.blur(); return; }
    closeTask();
  }
}

export function closeTask(updateHash = true) {
  if (!state) return;
  const a = document.activeElement;
  if (a && state.overlay.contains(a)) a.blur(); // dispara salvamentos pendentes
  const ov = state.overlay;
  ov.classList.add('leaving');
  setTimeout(() => ov.remove(), 160);
  state = null;
  document.removeEventListener('keydown', onKey);
  if (updateHash && location.hash.includes('tarefa=')) history.pushState(null, '', routeHash());
  loadTasks().then(renderContent).catch(() => {});
}

export async function refreshTask() {
  if (!state) return;
  const id = state.id;
  try {
    const data = await api('GET', `/api/tasks/${id}`);
    if (!state || state.id !== id) return;
    state.data = data;
    render();
  } catch (e) {
    if (e.status === 404) { toast('Esta tarefa não existe mais', { error: true }); closeTask(); }
    else fail(e);
  }
}

// Atualiza campos da tarefa aberta
async function patch(p) {
  const id = state.id;
  try {
    await api('PATCH', `/api/tasks/${id}`, p);
    await refreshTask();
    const i = S.tasks.findIndex((t) => t.id === id);
    if (i >= 0 && state?.data) { S.tasks[i] = state.data.task; renderContent(); }
  } catch (e) {
    // Aviso ao concluir com subtarefas abertas ou dependências pendentes
    if (e.code === 'incomplete' && !p.force) {
      if (await confirmDialog('Concluir mesmo assim?', e.message + '.', { ok: 'Concluir assim mesmo' })) return patch({ ...p, force: true });
      return refreshTask();
    }
    fail(e); await refreshTask();
  }
}

async function syncTimer() {
  try { await loadBootstrap(); } catch { /* offline */ }
  renderSidebar();
}

function activityText(a) {
  const d = a.data || {};
  const names = (ids = []) => ids.map((i) => userById(i)?.name || 'alguém').join(', ');
  switch (a.type) {
    case 'created': return 'criou esta tarefa';
    case 'status': return `mudou o status de <b>${esc(d.from)}</b> para <b>${esc(d.to)}</b>`;
    case 'title': return `renomeou para <b>${esc(d.to)}</b>`;
    case 'description': return 'atualizou a descrição';
    case 'priority': return d.to ? `definiu a prioridade como <b>${esc(PRIORITY[d.to]?.label)}</b>` : 'removeu a prioridade';
    case 'due_date': return d.to ? `definiu o prazo para <b>${esc(fmtDate(d.to))}</b>` : 'removeu o prazo';
    case 'start_date': return d.to ? `definiu o início para <b>${esc(fmtDate(d.to))}</b>` : 'removeu a data de início';
    case 'assigned': return `atribuiu a <b>${esc(names(d.users))}</b>`;
    case 'unassigned': return `removeu <b>${esc(names(d.users))}</b>`;
    case 'moved': return `moveu de <b>${esc(d.from)}</b> para <b>${esc(d.to)}</b>`;
    case 'archived': return 'arquivou a tarefa';
    case 'unarchived': return 'restaurou a tarefa';
    case 'checklist_add': return `adicionou ao checklist: <b>${esc(d.text)}</b>`;
    case 'attachment': return `anexou <b>${esc(d.filename)}</b>`;
    case 'estimate': return d.to ? `estimou em <b>${esc(fmtMinutes(d.to))}</b>` : 'removeu a estimativa';
    case 'dependency': return `passou a esperar <b>${esc(d.title)}</b>`;
    case 'proof_resolved': return 'resolveu uma marcação na peça';
    default: return esc(a.type);
  }
}

function commentBody(text) {
  let html = esc(text);
  for (const u of S.users) {
    const first = u.name.split(' ')[0];
    if (!first) continue;
    const re = new RegExp('@' + first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, (m) => `<span class="mention">${m}</span>`);
  }
  return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="text-decoration:underline">$1</a>');
}

function render() {
  const { task: t, list, parent, subtasks, checklist, comments, activity, attachments, watchers, time_entries: times = [], waiting_on: waiting = [], blocking = [] } = state.data;
  const myTimer = t.timers.find((x) => x.user_id === S.me.id);
  const pinsBy = {};
  for (const c of comments) if (c.attachment_id) (pinsBy[c.attachment_id] ||= []).push(c);
  const space = list && spaceById(list.space_id);
  const st = statusOf(t);
  const watching = watchers.includes(S.me.id);
  const feed = [...activity.map((a) => ({ kind: 'a', at: a.created_at, a })), ...comments.map((c) => ({ kind: 'c', at: c.created_at, c }))]
    .sort((x, y) => (x.at < y.at ? -1 : 1));
  const checkDone = checklist.filter((c) => c.done).length;
  const modal = state.overlay.querySelector('.modal');
  const feedEl = modal.querySelector('.feed');
  const atBottom = !feedEl || feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 40;
  const mainScroll = state.overlay.scrollTop;
  const draft = modal.querySelector('[data-comment]')?.value || '';

  modal.innerHTML = `
    <div class="modal-head">
      <div class="crumbs">${space ? `<span>${esc(space.name)}</span>${icon('chevronRight', 'sm')}` : ''}<span>${esc(list?.name || '')}</span>
        ${parent ? `${icon('chevronRight', 'sm')}<a href="${taskHash(parent.id)}">${esc(parent.title)}</a>` : ''}</div>
      <button class="btn btn-text btn-sm" data-t="watch" title="${watching ? 'Você recebe notificações desta tarefa' : 'Receber notificações'}">${icon('bell', 'sm')}${watching ? 'Seguindo' : 'Seguir'}</button>
      <button class="icon-btn" data-t="menu" aria-label="Mais opções">${icon('more')}</button>
      <button class="icon-btn" data-t="close" aria-label="Fechar">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="task-main">
        <textarea class="task-title" rows="1" data-field="title" aria-label="Título">${esc(t.title)}</textarea>
        <div class="props">
          <span class="k">${icon('check', 'sm')}Status</span>
          <span class="v">${statusPill(st, 'button', 'data-t="status"', 'lg')}
            ${!isDone(t) ? `<button class="icon-btn" data-t="complete" title="Marcar como concluída" aria-label="Concluir">${icon('check', 'sm')}</button>` : ''}</span>
          <span class="k">${icon('users', 'sm')}Responsáveis</span>
          <span class="v"><button class="prop-btn" data-t="assignees">${t.assignees.length ? t.assignees.map((id) => { const u = userById(id); return u ? `<span style="display:inline-flex;align-items:center;gap:6px">${avatar(u)}<span class="caption">${esc(u.name.split(' ')[0])}</span></span>` : ''; }).join('') : `<span class="avatar-empty">${icon('plus', 'sm')}</span><span class="faint">Atribuir</span>`}</button></span>
          <span class="k">${icon('calendar', 'sm')}Início</span>
          <span class="v"><input type="date" class="date-input" data-date="start_date" value="${esc(t.start_date || '')}" aria-label="Data de início"></span>
          <span class="k">${icon('calendar', 'sm')}Prazo</span>
          <span class="v"><input type="date" class="date-input" data-date="due_date" value="${esc(t.due_date || '')}" aria-label="Prazo"
            style="${t.due_date && t.due_date < new Date().toISOString().slice(0, 10) && !isDone(t) ? 'color:var(--danger)' : ''}"></span>
          <span class="k">${icon('flag', 'sm')}Prioridade</span>
          <span class="v"><button class="prop-btn" data-t="priority">${prioHtml(t.priority)}</button></span>
          <span class="k">${icon('clock', 'sm')}Estimativa</span>
          <span class="v"><input class="date-input" style="width:120px" data-estimate placeholder="ex.: 2h30" value="${t.time_estimate ? esc(fmtMinutes(t.time_estimate)) : ''}" aria-label="Estimativa de tempo"></span>
          <span class="k">${icon('clock', 'sm')}Tempo</span>
          <span class="v"><button class="prop-btn ${myTimer ? 'timer-on' : ''}" data-t="timer">${icon(myTimer ? 'stop' : 'play', 'sm')}${myTimer ? `<span data-timer-elapsed data-since="${esc(myTimer.started_at)}">${elapsed(myTimer.started_at)}</span>` : 'Iniciar'}</button>
            <span class="caption ${t.time_estimate && t.time_spent > t.time_estimate ? '' : 'faint'}" style="${t.time_estimate && t.time_spent > t.time_estimate ? 'color:var(--warning)' : ''}">${fmtMinutes(t.time_spent)}${t.time_estimate ? ' de ' + fmtMinutes(t.time_estimate) : ' registrado'}</span></span>
          <span class="k">${icon('tag', 'sm')}Etiquetas</span>
          <span class="v">${t.tags.map((id) => tagHtml(tagById(id), true)).join('')}<button class="prop-btn" data-t="tags" style="margin-left:0">${icon('plus', 'sm')}${t.tags.length ? '' : '<span class="faint">Adicionar</span>'}</button></span>
        </div>

        <section>
          <div class="section-title"><h3 class="h-card">Descrição</h3></div>
          <textarea class="desc" data-field="description" placeholder="Escreva o briefing, referências, formatos e observações…">${esc(t.description)}</textarea>
        </section>

        ${!t.parent_id ? `<section class="subtasks">
          <div class="section-title"><h3 class="h-card">Subtarefas <span class="faint caption">${subtasks.filter(isDone).length}/${subtasks.length}</span></h3></div>
          <div class="rows">
            ${subtasks.map((s) => { const sst = statusOf(s); return `<div class="row ${isDone(s) ? 'done' : ''}" data-sub="${s.id}">
              <div class="title-cell"><input type="checkbox" class="check" data-sub-done="${s.id}" ${isDone(s) ? 'checked' : ''} aria-label="Concluir subtarefa"><span class="t">${esc(s.title)}</span></div>
              <div>${statusPill(sst)}</div><div>${avatars(s.assignees, 2)}</div><div>${s.due_date ? `<span class="date">${fmtDate(s.due_date)}</span>` : ''}</div></div>`; }).join('')}
            <div class="add-row">${icon('plus', 'sm')}<input data-add-sub placeholder="Adicionar subtarefa e pressionar Enter" aria-label="Nova subtarefa"></div>
          </div>
        </section>` : ''}

        <section>
          <div class="section-title"><h3 class="h-card">Dependências</h3>
            <span style="display:flex;gap:4px"><button class="btn btn-text btn-sm" data-t="dep-wait">${icon('plus', 'sm')}Aguarda</button><button class="btn btn-text btn-sm" data-t="dep-block">${icon('plus', 'sm')}Bloqueia</button></span></div>
          ${!waiting.length && !blocking.length ? '<p class="caption faint" style="margin:0">Ligue tarefas que precisam acontecer em ordem, como “Aprovação do roteiro” antes de “Edição do vídeo”.</p>' : ''}
          ${waiting.map((d) => depRow(d, 'wait')).join('')}${blocking.map((d) => depRow(d, 'block')).join('')}
        </section>

        <section>
          <div class="section-title"><h3 class="h-card">Checklist <span class="faint caption">${checkDone}/${checklist.length}</span></h3></div>
          ${checklist.length ? `<div class="progress" style="margin-bottom:8px"><i style="width:${Math.round((checkDone / checklist.length) * 100)}%"></i></div>` : ''}
          ${checklist.map((c) => `<div class="check-item ${c.done ? 'done' : ''}">
            <input type="checkbox" class="check" data-check-done="${c.id}" ${c.done ? 'checked' : ''} aria-label="Marcar item">
            <input class="txt" data-check-text="${c.id}" value="${esc(c.text)}" aria-label="Item">
            <button class="icon-btn" data-check-del="${c.id}" aria-label="Remover item">${icon('trash', 'sm')}</button></div>`).join('')}
          <div class="check-item"><span style="width:16px;display:inline-flex;color:var(--text-faint)">${icon('plus', 'sm')}</span><input class="txt" data-add-check placeholder="Adicionar item" aria-label="Novo item do checklist"></div>
        </section>

        <section>
          <div class="section-title"><h3 class="h-card">Anexos <span class="faint caption">${attachments.length}</span></h3></div>
          ${attachments.length ? `<div class="attachments" style="margin-bottom:10px">${attachments.map((a) => {
            const img = /^image\/(png|jpe?g|gif|webp)$/.test(a.mime);
            const pins = pinsBy[a.id] || [], openPins = pins.filter((c) => !c.resolved).length;
            return `<div class="att">${img ? `<button class="thumb" data-proof="${a.id}" title="Abrir para revisar">${`<img src="/api/attachments/${a.id}?inline=1" alt="${esc(a.filename)}" loading="lazy">`}${pins.length ? `<span class="pin-count ${openPins ? '' : 'ok'}">${icon('pin', 'sm')}${openPins || '✓'}</span>` : ''}</button>`
              : `<a class="thumb" href="/api/attachments/${a.id}" target="_blank" rel="noopener">${icon('file', 'lg')}</a>`}
              <div class="meta"><div class="name" title="${esc(a.filename)}">${esc(a.filename)}</div><div class="faint">${fmtSize(a.size)} · ${esc(userById(a.user_id)?.name.split(' ')[0] || '')}${img ? ' · <span style="color:var(--text-muted)">revisar</span>' : ''}</div></div>
              <a class="icon-btn" style="position:absolute;top:6px;left:6px;background:rgba(23,23,33,.8)" href="/api/attachments/${a.id}" download aria-label="Baixar">${icon('download', 'sm')}</a>
              <button class="icon-btn del" data-att-del="${a.id}" aria-label="Remover anexo">${icon('trash', 'sm')}</button></div>`;
          }).join('')}</div>` : ''}
          <label class="dropzone" data-dropzone>${icon('paperclip', 'sm')} Arraste arquivos aqui ou <u>clique para enviar</u> (até 25 MB)<input type="file" multiple hidden data-file></label>
        </section>

        <section>
          <div class="section-title"><h3 class="h-card">Registro de tempo <span class="faint caption">${fmtMinutes(t.time_spent)}</span></h3></div>
          <form class="time-add" data-time-form>
            <input class="input input-sm" name="dur" placeholder="Tempo (ex.: 1h30)" aria-label="Tempo gasto" required>
            <input class="input input-sm" name="date" type="date" value="${today()}" style="color-scheme:dark;width:150px" aria-label="Dia">
            <input class="input input-sm" name="note" placeholder="O que foi feito (opcional)" aria-label="Nota">
            <button class="btn btn-ghost btn-sm" type="submit">Lançar</button>
          </form>
          ${times.map((e) => `<div class="time-entry">${avatar(userById(e.user_id))}<span>${esc(userById(e.user_id)?.name.split(' ')[0] || '')}</span>
            <b>${e.ended_at ? fmtMinutes(e.minutes) : '<span class="running">rodando</span>'}</b><span class="faint ellipsis" style="flex:1">${esc(e.note || '')}</span>
            <span class="faint caption">${fmtDate(e.started_at.slice(0, 10))}</span>
            ${e.ended_at && (e.user_id === S.me.id || S.me.role === 'admin') ? `<button class="icon-btn" data-time-del="${e.id}" aria-label="Apagar registro">${icon('trash', 'sm')}</button>` : ''}</div>`).join('')}
        </section>
      </div>

      <aside class="task-side">
        <div class="side-head"><h3 class="h-card">Atividade</h3><span class="caption faint">Criada ${timeAgo(t.created_at)} por ${esc(userById(t.created_by)?.name || '—')}</span></div>
        <div class="feed">
          ${feed.map((f) => f.kind === 'a'
            ? `<div class="feed-act"><span><b>${esc(userById(f.a.user_id)?.name || 'Alguém')}</b> ${activityText(f.a)}</span><span class="when">${timeAgo(f.at)}</span></div>`
            : `<div class="comment">${avatar(userById(f.c.user_id))}<div class="bubble"><div class="who"><b>${esc(userById(f.c.user_id)?.name || 'Alguém')}</b><span class="when">${timeAgo(f.at)}${f.c.edited_at ? ' · editado' : ''}</span>
                ${f.c.user_id === S.me.id || S.me.role === 'admin' ? `<span class="acts">${f.c.user_id === S.me.id ? `<button class="icon-btn" style="width:22px;height:22px" data-c-edit="${f.c.id}" aria-label="Editar">${icon('edit', 'sm')}</button>` : ''}<button class="icon-btn" style="width:22px;height:22px" data-c-del="${f.c.id}" aria-label="Excluir">${icon('trash', 'sm')}</button></span>` : ''}</div>
                ${f.c.attachment_id ? `<button class="proof-ref ${f.c.resolved ? 'ok' : ''}" data-proof="${f.c.attachment_id}" data-focus-pin="${f.c.id}">${icon('pin', 'sm')}${f.c.resolved ? 'Resolvido · ' : ''}na peça ${esc(attachments.find((a) => a.id === f.c.attachment_id)?.filename || '')}</button>` : ''}
                <div class="txt" data-c-body="${f.c.id}">${commentBody(f.c.body)}</div></div></div>`).join('')}
        </div>
        <div class="composer">
          <textarea class="textarea" data-comment placeholder="Escreva um comentário… use @nome para mencionar">${esc(draft)}</textarea>
          <div class="composer-actions"><span class="caption faint">Ctrl + Enter para enviar</span><button class="btn btn-primary btn-sm" data-t="send">Comentar</button></div>
        </div>
      </aside>
    </div>`;
  autosize(modal.querySelector('.task-title'));
  const f = modal.querySelector('.feed');
  if (atBottom) f.scrollTop = f.scrollHeight;
  state.overlay.scrollTop = mainScroll;
}

function depRow(d, kind) {
  const done = !!d.completed_at;
  const st = statusOf(d);
  return `<div class="dep ${kind}"><span class="dep-kind">${kind === 'wait' ? (done ? icon('check', 'sm') : icon('lock', 'sm')) + 'Aguarda' : icon('move', 'sm') + 'Bloqueia'}</span>
    <a class="ellipsis" href="${taskHash(d.id)}">${esc(d.title)}</a>${statusPill(st)}
    <button class="icon-btn" data-dep-del="${d.id}" data-kind="${kind}" aria-label="Remover dependência">${icon('x', 'sm')}</button></div>`;
}

// Busca tarefas para ligar como dependência
function pickDependency(anchor, kind) {
  let results = [];
  let seq = 0;
  const pop = menuPopover(anchor, {
    search: true, width: 340,
    items: () => (results.length ? results : [{ label: 'Digite para buscar tarefas' }]),
    onPick: async (id) => {
      if (!id) return;
      try {
        if (kind === 'wait') await api('POST', `/api/tasks/${state.id}/dependencies`, { depends_on: id });
        else await api('POST', `/api/tasks/${id}/dependencies`, { depends_on: state.id });
        await refreshTask(); loadTasks().then(renderContent).catch(() => {});
      } catch (e) { fail(e); }
    },
  });
  const input = pop.querySelector('.pop-search input');
  const run = async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (!q) { results = []; input.dispatchEvent(new Event('redraw')); return; }
    try {
      const rows = await api('GET', '/api/tasks?limit=20&q=' + encodeURIComponent(q));
      if (my !== seq) return;
      results = rows.filter((x) => x.id !== state.id).map((x) => ({ id: x.id, text: q.toLowerCase(), html: `${statusPill(statusOf(x))}<span class="ellipsis">${esc(x.title)}</span>` }));
      if (!results.length) results = [{ label: 'Nada encontrado' }];
      // redesenha o menu com os resultados
      const ev = new Event('input'); input.dispatchEvent(ev);
    } catch { /* ignora */ }
  };
  let timer;
  input.addEventListener('keyup', (e) => { if (e.key !== 'Enter') { clearTimeout(timer); timer = setTimeout(run, 180); } });
}

// ---------- revisão de peças (marcações sobre a imagem) ----------
function openProof(attId, focusId) {
  const att = state.data.attachments.find((a) => a.id === attId);
  if (!att) return;
  const wrap = document.createElement('div');
  wrap.className = 'overlay proof';
  wrap.style.zIndex = 65;
  document.body.append(wrap);
  let showResolved = false, draftAt = null;
  const close = () => { document.removeEventListener('keydown', onKey, true); wrap.classList.add('leaving'); setTimeout(() => wrap.remove(), 160); };
  const onKey = (e) => {
    if (e.key !== 'Escape' || document.querySelector('.popover')) return;
    e.stopPropagation();
    if (draftAt) { draftAt = null; draw(); } else close();
  };
  document.addEventListener('keydown', onKey, true);
  const pins = () => (state?.data?.comments || []).filter((c) => c.attachment_id === attId);
  const draw = () => {
    const all = pins();
    const list = all.filter((c) => showResolved || !c.resolved);
    const n = (c) => all.indexOf(c) + 1;
    wrap.innerHTML = `<div class="modal proof-modal" role="dialog" aria-label="Revisar peça">
      <div class="modal-head"><div class="crumbs" style="font-size:14px;color:var(--text)">${icon('pin', 'sm')}${esc(att.filename)}</div>
        <span class="caption faint">Clique na imagem para marcar um ponto e comentar</span>
        <a class="icon-btn" href="/api/attachments/${att.id}" download aria-label="Baixar">${icon('download')}</a>
        <button class="icon-btn" data-pclose aria-label="Fechar">${icon('x')}</button></div>
      <div class="proof-body">
        <div class="proof-stage"><div class="proof-img" data-stage>
          <img src="/api/attachments/${att.id}?inline=1" alt="${esc(att.filename)}" draggable="false">
          ${list.map((c) => `<button class="pin ${c.resolved ? 'ok' : ''} ${c.id === focusId ? 'focus' : ''}" style="left:${c.pin_x * 100}%;top:${c.pin_y * 100}%" data-pin="${c.id}" aria-label="Marcação ${n(c)}">${n(c)}</button>`).join('')}
          ${draftAt ? `<span class="pin draft" style="left:${draftAt.x * 100}%;top:${draftAt.y * 100}%">${all.length + 1}</span>
            <form class="pin-composer" data-pin-form style="left:${draftAt.x * 100}%;top:${draftAt.y * 100}%">
              <textarea class="textarea" placeholder="O que ajustar neste ponto?" required></textarea>
              <div style="display:flex;justify-content:flex-end;gap:6px"><button type="button" class="btn btn-text btn-sm" data-pin-cancel>Cancelar</button><button class="btn btn-primary btn-sm">Marcar</button></div>
            </form>` : ''}
        </div></div>
        <aside class="proof-side">
          <div class="side-head"><h3 class="h-card">Marcações <span class="faint caption">${all.filter((c) => !c.resolved).length} abertas</span></h3>
            <label class="caption muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" class="check" data-show-resolved ${showResolved ? 'checked' : ''}>Resolvidas</label></div>
          <div class="feed" style="max-height:none">
            ${list.length ? list.map((c) => `<div class="comment ${c.id === focusId ? 'focus' : ''}" data-pin-item="${c.id}"><span class="pin static ${c.resolved ? 'ok' : ''}">${n(c)}</span>
              <div class="bubble"><div class="who"><b>${esc(userById(c.user_id)?.name || 'Alguém')}</b><span class="when">${timeAgo(c.created_at)}</span></div>
              <div class="txt">${esc(c.body)}</div>
              <button class="btn btn-text btn-sm" style="margin:6px 0 0 -12px" data-resolve="${c.id}" data-v="${c.resolved ? 0 : 1}">${icon(c.resolved ? 'x' : 'check', 'sm')}${c.resolved ? 'Reabrir' : 'Resolver'}</button></div></div>`).join('')
              : '<p class="caption faint" style="margin:0">Nenhuma marcação ainda.</p>'}
          </div>
        </aside>
      </div></div>`;
    wrap.querySelector('[data-pin-form] textarea')?.focus();
    if (focusId) wrap.querySelector(`[data-pin-item="${focusId}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.addEventListener('click', async (e) => {
    if (e.target.closest('[data-pclose]')) return close();
    if (e.target.closest('[data-pin-cancel]')) { draftAt = null; return draw(); }
    const pin = e.target.closest('[data-pin], [data-pin-item]');
    if (pin && !e.target.closest('[data-resolve]')) { focusId = pin.dataset.pin || pin.dataset.pinItem; draftAt = null; return draw(); }
    const res = e.target.closest('[data-resolve]');
    if (res) { await api('PATCH', `/api/comments/${res.dataset.resolve}`, { resolved: res.dataset.v === '1' }).catch(fail); await refreshTask(); return draw(); }
    const img = e.target.closest('[data-stage] img');
    if (img) {
      const r = img.getBoundingClientRect();
      draftAt = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      focusId = null;
      draw();
    }
  });
  wrap.addEventListener('change', (e) => { if (e.target.matches('[data-show-resolved]')) { showResolved = e.target.checked; draw(); } });
  const submitPin = async (form) => {
    const body = form.querySelector('textarea').value.trim();
    if (!body || !draftAt) return;
    try {
      const c = await api('POST', `/api/tasks/${state.id}/comments`, { body, attachment_id: attId, x: draftAt.x, y: draftAt.y });
      draftAt = null; focusId = c.id;
      await refreshTask(); draw();
    } catch (ex) { fail(ex); }
  };
  wrap.addEventListener('submit', (e) => { e.preventDefault(); submitPin(e.target); });
  wrap.addEventListener('keydown', (e) => {
    if (e.target.matches('[data-pin-form] textarea') && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPin(e.target.form); }
  });
  draw();
}

async function uploadFiles(files) {
  const id = state.id;
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) { toast(`${file.name} passa de 25 MB`, { error: true }); continue; }
    try { await api('POST', `/api/tasks/${id}/attachments`, file, { headers: { 'X-Filename': encodeURIComponent(file.name) } }); }
    catch (e) { fail(e); }
  }
  toast(files.length > 1 ? 'Arquivos anexados' : 'Arquivo anexado');
  refreshTask();
}

async function sendComment(ta) {
  const body = ta.value.trim();
  if (!body) return;
  ta.value = '';
  try { await api('POST', `/api/tasks/${state.id}/comments`, { body }); await refreshTask(); }
  catch (e) { ta.value = body; fail(e); }
}

function bind(overlay) {
  overlay.addEventListener('click', async (e) => {
    if (!state?.data) return;
    const t = state.data.task;
    const b = e.target.closest('[data-t]');
    const act = b?.dataset.t;
    if (act === 'close') return closeTask();
    if (act === 'status') return pickStatus(b, t, patch);
    if (act === 'priority') return pickPriority(b, t, patch);
    if (act === 'assignees') return pickAssignees(b, { ...t }, patch);
    if (act === 'tags') return pickTags(b, { ...t }, patch);
    if (act === 'menu') return taskMenu(b, t, { inModal: true });
    if (act === 'send') return sendComment(overlay.querySelector('[data-comment]'));
    if (act === 'complete') {
      const done = listById(t.list_id)?.statuses.find((s) => s.type === 'done');
      if (done) return patch({ status: done.id });
    }
    if (act === 'watch') { await api('POST', `/api/tasks/${t.id}/watch`).catch(fail); return refreshTask(); }
    if (act === 'timer') {
      const running = t.timers.some((x) => x.user_id === S.me.id);
      try { await api('POST', running ? '/api/timer/stop' : `/api/tasks/${t.id}/timer`); if (running) toast('Tempo registrado'); } catch (ex) { fail(ex); }
      await refreshTask(); syncTimer(); return;
    }
    if (act === 'dep-wait') return pickDependency(b, 'wait');
    if (act === 'dep-block') return pickDependency(b, 'block');
    const proof = e.target.closest('[data-proof]');
    if (proof) { e.preventDefault(); return openProof(proof.dataset.proof, proof.dataset.focusPin); }
    const ddel = e.target.closest('[data-dep-del]');
    if (ddel) {
      const other = ddel.dataset.depDel;
      const url = ddel.dataset.kind === 'wait' ? `/api/tasks/${t.id}/dependencies/${other}` : `/api/tasks/${other}/dependencies/${t.id}`;
      await api('DELETE', url).catch(fail); return refreshTask();
    }
    const tdel = e.target.closest('[data-time-del]');
    if (tdel) { await api('DELETE', `/api/time/${tdel.dataset.timeDel}`).catch(fail); return refreshTask(); }
    const rm = e.target.closest('[data-remove-tag]');
    if (rm) return patch({ tags: t.tags.filter((x) => x !== rm.dataset.removeTag) });
    const del = e.target.closest('[data-check-del]');
    if (del) { await api('DELETE', `/api/checklist/${del.dataset.checkDel}`).catch(fail); return refreshTask(); }
    const att = e.target.closest('[data-att-del]');
    if (att) { await api('DELETE', `/api/attachments/${att.dataset.attDel}`).catch(fail); return refreshTask(); }
    const cdel = e.target.closest('[data-c-del]');
    if (cdel) { await api('DELETE', `/api/comments/${cdel.dataset.cDel}`).catch(fail); return refreshTask(); }
    const cedit = e.target.closest('[data-c-edit]');
    if (cedit) {
      const id = cedit.dataset.cEdit;
      const c = state.data.comments.find((x) => x.id === id);
      const box = overlay.querySelector(`[data-c-body="${id}"]`);
      box.innerHTML = `<textarea class="textarea" style="min-height:60px">${esc(c.body)}</textarea><div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px"><button class="btn btn-text btn-sm" data-c-cancel>Cancelar</button><button class="btn btn-ghost btn-sm" data-c-save="${id}">Salvar</button></div>`;
      box.querySelector('textarea').focus();
      return;
    }
    if (e.target.closest('[data-c-cancel]')) return refreshTask();
    const csave = e.target.closest('[data-c-save]');
    if (csave) {
      const body = csave.closest('[data-c-body]').querySelector('textarea').value;
      await api('PATCH', `/api/comments/${csave.dataset.cSave}`, { body }).catch(fail);
      return refreshTask();
    }
    const sub = e.target.closest('[data-sub]');
    if (sub && !e.target.closest('input')) return go(taskHash(sub.dataset.sub));
  });

  overlay.addEventListener('change', async (e) => {
    if (!state?.data) return;
    const t = state.data.task;
    const d = e.target.closest('[data-date]');
    if (d) return patch({ [d.dataset.date]: d.value || null });
    const cd = e.target.closest('[data-check-done]');
    if (cd) { await api('PATCH', `/api/checklist/${cd.dataset.checkDone}`, { done: cd.checked }).catch(fail); return refreshTask(); }
    const sd = e.target.closest('[data-sub-done]');
    if (sd) {
      const s = state.data.subtasks.find((x) => x.id === sd.dataset.subDone);
      const l = listById(s.list_id);
      const status = sd.checked ? l.statuses.find((x) => x.type === 'done')?.id : (l.statuses.find((x) => x.type === 'open') || l.statuses[0]).id;
      await api('PATCH', `/api/tasks/${s.id}`, { status }).catch(fail);
      return refreshTask();
    }
    if (e.target.matches('[data-file]')) { uploadFiles([...e.target.files]); e.target.value = ''; }
    void t;
  });

  overlay.addEventListener('input', (e) => { if (e.target.matches('.task-title')) autosize(e.target); });
  overlay.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-time-form]')) return;
    e.preventDefault();
    const f = e.target;
    const m = parseDuration(f.dur.value);
    if (!m || Number.isNaN(m)) { toast('Use um formato como 2h, 45min ou 1h30', { error: true }); return; }
    try { await api('POST', `/api/tasks/${state.id}/time`, { minutes: m, date: f.date.value, note: f.note.value }); toast('Tempo lançado'); await refreshTask(); }
    catch (ex) { fail(ex); }
  });

  overlay.addEventListener('focusout', async (e) => {
    if (!state?.data) return;
    const t = state.data.task;
    const f = e.target.closest('[data-field]');
    if (f) {
      const v = f.dataset.field === 'title' ? f.value.replace(/\s+/g, ' ').trim() : f.value;
      if (f.dataset.field === 'title' && !v) { f.value = t.title; return; }
      if (v !== t[f.dataset.field]) await patch({ [f.dataset.field]: v });
      return;
    }
    if (e.target.matches('[data-estimate]')) {
      const raw = e.target.value.trim();
      const m = raw ? parseDuration(raw) : null;
      if (Number.isNaN(m)) { toast('Use um formato como 2h, 45min ou 1h30', { error: true }); e.target.value = t.time_estimate ? fmtMinutes(t.time_estimate) : ''; return; }
      if (m !== (t.time_estimate ?? null)) await patch({ time_estimate: m });
      return;
    }
    const ct = e.target.closest('[data-check-text]');
    if (ct) {
      const item = state.data.checklist.find((c) => c.id === ct.dataset.checkText);
      if (item && ct.value.trim() && ct.value.trim() !== item.text) await api('PATCH', `/api/checklist/${item.id}`, { text: ct.value }).catch(fail);
    }
  });

  overlay.addEventListener('keydown', async (e) => {
    if (!state?.data) return;
    if (e.target.matches('.task-title, [data-estimate]') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); return; }
    if (e.target.matches('[data-comment]') && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendComment(e.target); return; }
    if (e.key !== 'Enter') return;
    if (e.target.matches('[data-add-sub]') && e.target.value.trim()) {
      const title = e.target.value; e.target.value = '';
      try { await api('POST', '/api/tasks', { title, parent_id: state.id }); await refreshTask(); overlay.querySelector('[data-add-sub]')?.focus(); } catch (ex) { fail(ex); }
    }
    if (e.target.matches('[data-add-check]') && e.target.value.trim()) {
      const text = e.target.value; e.target.value = '';
      try { await api('POST', `/api/tasks/${state.id}/checklist`, { text }); await refreshTask(); overlay.querySelector('[data-add-check]')?.focus(); } catch (ex) { fail(ex); }
    }
    if (e.target.matches('[data-check-text]')) e.target.blur();
  });

  overlay.addEventListener('dragover', (e) => {
    const z = e.target.closest('[data-dropzone]');
    if (z && e.dataTransfer.types.includes('Files')) { e.preventDefault(); z.classList.add('over'); }
  });
  overlay.addEventListener('dragleave', (e) => e.target.closest('[data-dropzone]')?.classList.remove('over'));
  overlay.addEventListener('drop', (e) => {
    const z = e.target.closest('[data-dropzone]');
    if (z && e.dataTransfer.files.length) { e.preventDefault(); z.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); }
  });
  overlay.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && !e.target.closest('textarea, input')) { e.preventDefault(); uploadFiles(files); }
  });
}

void renderSidebar;
