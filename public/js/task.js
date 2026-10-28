// Modal de detalhe da tarefa: campos, subtarefas, checklist, anexos, comentários e atividade.
import { esc, icon, PRIORITY, fmtDate, timeAgo, fmtSize, api, toast, fail, autosize } from './ui.js';
import {
  S, go, routeHash, taskHash, userById, listById, spaceById, tagById, statusOf, avatar, avatars, statusPill, prioHtml, tagHtml,
  pickStatus, pickPriority, pickAssignees, pickTags, taskMenu, loadTasks, renderContent, renderSidebar, isDone,
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
    if (i >= 0) { const t = await api('GET', `/api/tasks/${id}`); S.tasks[i] = t.task; renderContent(); }
  } catch (e) { fail(e); await refreshTask(); }
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
  const { task: t, list, parent, subtasks, checklist, comments, activity, attachments, watchers } = state.data;
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
            return `<div class="att"><a class="thumb" href="/api/attachments/${a.id}${img ? '?inline=1' : ''}" target="_blank" rel="noopener">${img ? `<img src="/api/attachments/${a.id}?inline=1" alt="${esc(a.filename)}" loading="lazy">` : icon('file', 'lg')}</a>
              <div class="meta"><div class="name" title="${esc(a.filename)}">${esc(a.filename)}</div><div class="faint">${fmtSize(a.size)} · ${esc(userById(a.user_id)?.name.split(' ')[0] || '')}</div></div>
              <a class="icon-btn" style="position:absolute;top:6px;left:6px;background:rgba(23,23,33,.8)" href="/api/attachments/${a.id}" download aria-label="Baixar">${icon('download', 'sm')}</a>
              <button class="icon-btn del" data-att-del="${a.id}" aria-label="Remover anexo">${icon('trash', 'sm')}</button></div>`;
          }).join('')}</div>` : ''}
          <label class="dropzone" data-dropzone>${icon('paperclip', 'sm')} Arraste arquivos aqui ou <u>clique para enviar</u> (até 25 MB)<input type="file" multiple hidden data-file></label>
        </section>
      </div>

      <aside class="task-side">
        <div class="side-head"><h3 class="h-card">Atividade</h3><span class="caption faint">Criada ${timeAgo(t.created_at)} por ${esc(userById(t.created_by)?.name || '—')}</span></div>
        <div class="feed">
          ${feed.map((f) => f.kind === 'a'
            ? `<div class="feed-act"><span><b>${esc(userById(f.a.user_id)?.name || 'Alguém')}</b> ${activityText(f.a)}</span><span class="when">${timeAgo(f.at)}</span></div>`
            : `<div class="comment">${avatar(userById(f.c.user_id))}<div class="bubble"><div class="who"><b>${esc(userById(f.c.user_id)?.name || 'Alguém')}</b><span class="when">${timeAgo(f.at)}${f.c.edited_at ? ' · editado' : ''}</span>
                ${f.c.user_id === S.me.id || S.me.role === 'admin' ? `<span class="acts">${f.c.user_id === S.me.id ? `<button class="icon-btn" style="width:22px;height:22px" data-c-edit="${f.c.id}" aria-label="Editar">${icon('edit', 'sm')}</button>` : ''}<button class="icon-btn" style="width:22px;height:22px" data-c-del="${f.c.id}" aria-label="Excluir">${icon('trash', 'sm')}</button></span>` : ''}</div>
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
    const ct = e.target.closest('[data-check-text]');
    if (ct) {
      const item = state.data.checklist.find((c) => c.id === ct.dataset.checkText);
      if (item && ct.value.trim() && ct.value.trim() !== item.text) await api('PATCH', `/api/checklist/${item.id}`, { text: ct.value }).catch(fail);
    }
  });

  overlay.addEventListener('keydown', async (e) => {
    if (!state?.data) return;
    if (e.target.matches('.task-title') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); return; }
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
