// Entende um texto solto (mensagem do WhatsApp, anotação) e tira dele o título, o prazo e a urgência.
// Ex.: "Post Black Friday sexta" -> prazo na próxima sexta. "Banner 20/11 urgente" -> 20/11, prioridade urgente.

const WEEKDAYS = [
  [/\b(domingo|dom)\b/, 0], [/\b(segunda(-feira)?|seg)\b/, 1], [/\b(ter[cç]a(-feira)?|ter)\b/, 2], [/\b(quarta(-feira)?|qua)\b/, 3],
  [/\b(quinta(-feira)?|qui)\b/, 4], [/\b(sexta(-feira)?|sex)\b/, 5], [/\b(s[aá]bado|sab|s[aá]b)\b/, 6],
];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plus = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Procura a expressão de data no texto. Devolve { date, match } ou null.
function findDate(text, now) {
  const t = strip(text);
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tries = [
    [/\b(pra |para |ate |até )?depois de amanha\b/, () => plus(base, 2)],
    [/\b(pra |para |ate )?amanha\b/, () => plus(base, 1)],
    [/\b(pra |para |ate )?hoje\b/, () => base],
    [/\b(pra |para |ate )?semana que vem\b|\b(pra |para |ate )?(na )?proxima semana\b/, () => plus(base, ((8 - base.getDay()) % 7) || 7)],
    [/\b(pra |para |ate )?(o )?fim de semana\b/, () => plus(base, (6 - base.getDay() + 7) % 7 || 7)],
    [/\b(pra |para |ate )?(o )?dia (\d{1,2})\b/, (m) => {
      const d = +m[3]; let x = new Date(base.getFullYear(), base.getMonth(), d);
      if (x < base) x = new Date(base.getFullYear(), base.getMonth() + 1, d);
      return d >= 1 && d <= 31 ? x : null;
    }],
    [/\b(pra |para |ate |em )?(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/, (m) => {
      const d = +m[2], mo = +m[3] - 1;
      let y = m[4] ? +m[4] : base.getFullYear();
      if (y < 100) y += 2000;
      if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
      let x = new Date(y, mo, d);
      if (!m[4] && x < plus(base, -30)) x = new Date(y + 1, mo, d); // "05/01" em dezembro é o ano que vem
      return x;
    }],
  ];
  for (const [re, fn] of tries) {
    const m = t.match(re);
    if (m) { const d = fn(m); if (d) return { date: ymd(d), index: m.index, length: m[0].length }; }
  }
  for (const [re, wd] of WEEKDAYS) {
    const m = t.match(new RegExp(String.raw`\b(na |no |pra |para |ate )?(proxim[ao] )?` + re.source.slice(2)));
    if (m) {
      let n = (wd - base.getDay() + 7) % 7;
      if (n === 0 || m[2]) n = n || 7; // "sexta" sendo sexta = a próxima; "próxima sexta" nunca é hoje
      return { date: ymd(plus(base, n)), index: m.index, length: m[0].length };
    }
  }
  return null;
}

export function parseQuick(raw, now = new Date()) {
  let text = String(raw || '').replace(/\r/g, '').trim();
  // O WhatsApp às vezes manda "[11/11 15:02] Fulano: mensagem" quando se encaminha/copia
  text = text.replace(/^\[[^\]]{4,25}\]\s*[^:\n]{1,40}:\s*/, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let first = lines[0] || '';
  const out = { title: '', due_date: null, priority: null, description: '' };
  const pr = strip(first).match(/\b(urgente|urgencia)\b/);
  if (pr) out.priority = 'urgent';
  const found = findDate(first, now) || (lines.length > 1 ? findDate(lines.slice(1).join(' '), now) : null);
  if (found) {
    out.due_date = found.date;
    if (findDate(first, now)) {
      // tira a expressão de data do título (o índice vale porque strip() preserva o tamanho em letras simples)
      const f = findDate(first, now);
      first = (first.slice(0, f.index) + ' ' + first.slice(f.index + f.length));
    }
  }
  if (pr) first = first.replace(/\burgente\b|\burg[eê]ncia\b/i, ' ');
  first = first.replace(/\s{2,}/g, ' ').replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, '').trim();
  if (first.length > 120) { out.title = first.slice(0, 117).replace(/\s+\S*$/, '') + '…'; out.description = text; }
  else { out.title = first || 'Nova tarefa'; if (lines.length > 1) out.description = text; }
  out.title = out.title.charAt(0).toUpperCase() + out.title.slice(1);
  return out;
}

// ---------- Modelo de mensagem ----------
// Linhas "Campo: valor" (a ordem não importa, maiúsculas e acentos também não). Ex.:
//   Tarefa: Post Black Friday
//   Lista: Social media
//   Prazo: sexta
//   Responsável: Bruno, eu
//   Prioridade: alta
//   Etiquetas: vídeo
//   Descrição: 3 versões, uma para stories
export const TEMPLATE_FIELDS = ['Tarefa', 'Lista', 'Prazo', 'Início', 'Responsável', 'Prioridade', 'Status', 'Etiquetas', 'Descrição'];
const KEYS = {
  title: ['tarefa', 'titulo', 'demanda', 'job', 'o que'],
  list: ['lista', 'projeto', 'cliente', 'onde'],
  due: ['prazo', 'entrega', 'data', 'para quando', 'pra quando', 'quando'],
  start: ['inicio', 'comeco', 'comecar'],
  people: ['responsavel', 'responsaveis', 'quem', 'para quem', 'pra quem', 'designer', 'equipe'],
  priority: ['prioridade', 'urgencia'],
  status: ['status', 'etapa', 'fase'],
  tags: ['etiqueta', 'etiquetas', 'tag', 'tags', 'formato'],
  desc: ['descricao', 'detalhes', 'obs', 'observacao', 'observacoes', 'briefing', 'notas'],
};
const PRIO_WORDS = { urgent: ['urgente', 'urgentissimo', 'pra ontem'], high: ['alta', 'alto', 'importante'], normal: ['normal', 'media', 'medio'], low: ['baixa', 'baixo', 'sem pressa'] };

function fieldOf(key) {
  const k = strip(key).replace(/[^a-z ]/g, '').trim();
  for (const [f, names] of Object.entries(KEYS)) if (names.includes(k)) return f;
  return null;
}
// Melhor nome parecido: igual > começa com > contém
function best(items, name, get) {
  const q = strip(name).trim();
  if (!q) return null;
  const scored = items.map((it) => { const n = strip(get(it)); return [it, n === q ? 3 : n.startsWith(q) || q.startsWith(n) ? 2 : n.includes(q) || q.includes(n) ? 1 : 0]; });
  scored.sort((a, b) => b[1] - a[1]);
  return scored[0]?.[1] ? scored[0][0] : null;
}
const splitList = (v) => v.split(/\s*(?:,|;|\/|\be\b|\+)\s*/i).map((x) => x.replace(/^@/, '').trim()).filter(Boolean);

export function hasTemplate(raw) {
  return String(raw || '').replace(/^\[[^\]]{4,25}\]\s*[^:\n]{1,40}:\s*/, '').split('\n').some((l) => { const m = l.match(/^\s*[*_]*([^:*_]{2,20})[*_]*\s*:/); return m && fieldOf(m[1]) === 'title'; });
}

// ctx = { lists, spaces, users, tags, me } (o estado do app)
export function parseTemplate(raw, ctx, now = new Date()) {
  const text = String(raw || '').replace(/\r/g, '').replace(/^\[[^\]]{4,25}\]\s*[^:\n]{1,40}:\s*/, '');
  const fields = {}; let cur = null;
  for (const line of text.split('\n')) {
    // aceita negrito do WhatsApp: *Prazo:* sexta
    const m = line.match(/^\s*[*_]*([^:*_]{2,20})[*_]*\s*:[*_]*\s*(.*)$/);
    const f = m && fieldOf(m[1]);
    if (f) { cur = f; fields[f] = (m[2] || '').replace(/[*_]+$/, '').trim(); }
    else if (cur === 'desc') fields.desc += (fields.desc ? '\n' : '') + line;
    else if (line.trim()) { fields.desc = (fields.desc ? fields.desc + '\n' : '') + line.trim(); cur = 'desc'; }
  }
  const out = { title: (fields.title || '').trim(), unknown: [] };
  if (fields.list) {
    // "Cliente Acme › Social media" ou só "Social media"
    const [a, b] = fields.list.split(/\s*(?:›|>|\/|-)\s*/);
    let l = null;
    if (b) { const sp = best(ctx.spaces, a, (s) => s.name); if (sp) l = best(ctx.lists.filter((x) => x.space_id === sp.id), b, (x) => x.name); }
    l ||= best(ctx.lists, fields.list, (x) => x.name) || (b ? best(ctx.lists, b, (x) => x.name) : null);
    if (l) out.list_id = l.id; else out.unknown.push(`lista "${fields.list}"`);
  }
  if (fields.due) { const d = findDate(fields.due, now); if (d) out.due_date = d.date; else out.unknown.push(`prazo "${fields.due}"`); }
  if (fields.start) { const d = findDate(fields.start, now); if (d) out.start_date = d.date; }
  if (fields.people) {
    out.assignees = [];
    for (const n of splitList(fields.people)) {
      if (['eu', 'mim', 'comigo'].includes(strip(n))) { out.assignees.push(ctx.me.id); continue; }
      const u = best(ctx.users.filter((x) => x.active !== 0), n, (x) => x.name) || ctx.users.find((x) => strip(x.email).startsWith(strip(n)));
      if (u) out.assignees.push(u.id); else out.unknown.push(`pessoa "${n}"`);
    }
    out.assignees = [...new Set(out.assignees)];
  }
  if (fields.priority) {
    const p = strip(fields.priority);
    out.priority = Object.entries(PRIO_WORDS).find(([, ws]) => ws.some((w) => p.includes(w)))?.[0] || null;
  }
  if (fields.tags) {
    out.tags = [];
    for (const n of splitList(fields.tags.replace(/#/g, ''))) { const t = best(ctx.tags, n, (x) => x.name); if (t) out.tags.push(t.id); else out.unknown.push(`etiqueta "${n}"`); }
  }
  if (fields.status) out.status_name = fields.status;
  if (fields.desc) out.description = fields.desc.trim();
  if (!out.title) out.title = parseQuick(text, now).title;
  return out;
}

export function templateText(example = false) {
  return example
    ? 'Tarefa: Post Black Friday\nLista: Social media\nPrazo: sexta\nResponsável: eu\nPrioridade: alta\nEtiquetas: \nDescrição: '
    : 'Tarefa: \nLista: \nPrazo: \nResponsável: \nPrioridade: \nEtiquetas: \nDescrição: ';
}
