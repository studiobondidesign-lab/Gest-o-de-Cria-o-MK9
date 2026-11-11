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
