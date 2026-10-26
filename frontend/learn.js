// ==========================================
// APRENDIZADO CONTÍNUO
// Cada confirmação ("É essa!") e recusa ("Não é") vira um evento. Os eventos ficam no aparelho e vão para o banco
// (tabela search_events) quando há conexão. Com eles o app mostra o acerto REAL das sugestões, e o mesmo registro serve
// para ajustar a busca depois (a cor já aprende na hora, com as peças confirmadas: ver calibAdd).
// ==========================================
const Learn = (() => {
  const KEY = 'pf_learn_events';
  const MAX = 3000;
  let timer = null;
  let syncing = false;

  function load() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX))); } catch (_) { /* sem espaço: segue sem guardar */ }
  }

  // mode: find (buraco→peça pela arte) | hole (foto do buraco) | locate (peça→mapa) | count (contagem das peças)
  // outcome: hit (confirmou) | miss (recusou)
  function log(mode, outcome, info = {}) {
    if (!currentPuzzle) return;
    const list = load();
    list.push({ t: Date.now(), puzzle: currentPuzzle.id, mode, outcome, ...info, sent: false });
    save(list);
    clearTimeout(timer);
    timer = setTimeout(sync, 4000);
  }

  async function sync() {
    if (syncing || !supabaseClient) return;
    const list = load();
    const todo = list.filter((e) => !e.sent).slice(0, 200);
    if (!todo.length) return;
    syncing = true;
    try {
      const rows = todo.map(({ t, puzzle, mode, outcome, sent, ...rest }) => ({
        puzzle_id: puzzle, mode, outcome, payload: { ...rest, t },
      }));
      const { error } = await supabaseClient.from('search_events').insert(rows);
      if (error) return; // tabela ainda não existe ou sem rede: tenta de novo na próxima vez
      const now = load();
      const ids = new Set(todo.map((e) => e.t + e.mode + e.outcome));
      now.forEach((e) => { if (ids.has(e.t + e.mode + e.outcome)) e.sent = true; });
      save(now);
    } catch (_) { /* offline */ } finally { syncing = false; }
  }

  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');

  // Acerto das sugestões: de cada nível de confiança, quantas o usuário confirmou
  function stats(puzzleId) {
    const ev = load().filter((e) => !puzzleId || e.puzzle === puzzleId);
    const out = [];
    const rows = [['hole', 'Foto do buraco'], ['find', 'Buraco → peça (arte da caixa)'], ['locate', 'Peça → mapa']];
    for (const [mode, label] of rows) {
      const list = ev.filter((e) => e.mode === mode);
      if (!list.length) continue;
      const hits = list.filter((e) => e.outcome === 'hit');
      const first = list.filter((e) => e.rank === 1);
      const byConf = ['sure', 'maybe', 'low'].map((c) => {
        const l = list.filter((e) => e.conf === c);
        return { conf: c, n: l.length, ok: l.filter((e) => e.outcome === 'hit').length };
      }).filter((x) => x.n);
      out.push({
        mode, label, n: list.length, hits: hits.length,
        rank1: first.length ? { n: first.length, ok: first.filter((e) => e.outcome === 'hit').length } : null,
        // posição média da peça certa entre as sugestões (1 = sempre a primeira)
        avgRank: hits.length ? (hits.reduce((s, e) => s + (e.rank || 1), 0) / hits.length) : null,
        byConf,
      });
    }
    const counts = ev.filter((e) => e.mode === 'count');
    return { rows: out, count: counts.length ? { n: counts.length, ok: counts.filter((e) => e.auto === e.user).length } : null, events: ev.length, pending: ev.filter((e) => !e.sent).length };
  }

  const CONF_NAME = { sure: 'Muito provável / certa', maybe: 'Possível / talvez', low: 'Pouco provável' };

  function render() {
    const s = stats(currentPuzzle && currentPuzzle.id);
    const box = document.getElementById('learnBody');
    box.innerHTML = '';
    const add = (html) => { const d = document.createElement('div'); d.className = 'p-3 rounded-xl bg-slate-900 ring-1 ring-inset ring-slate-800 text-sm leading-snug'; d.innerHTML = html; box.appendChild(d); };
    if (!s.events) { add('Ainda sem dados. Use as buscas e confirme ("É essa!") ou recuse ("Não é") cada sugestão: o acerto real aparece aqui.'); }
    for (const r of s.rows) {
      let h = `<p class="font-bold text-slate-100">${r.label}</p><p class="text-slate-300 mt-1">${r.hits} confirmadas de ${r.n} decisões`;
      if (r.rank1) h += ` · a 1ª sugestão estava certa em <strong class="text-emerald-300">${pct(r.rank1.ok, r.rank1.n)}</strong> (${r.rank1.ok} de ${r.rank1.n})`;
      if (r.avgRank) h += ` · posição média da certa: ${r.avgRank.toFixed(1)}`;
      h += '</p>';
      if (r.byConf.length) h += '<ul class="mt-1.5 text-slate-400 text-xs space-y-0.5">' + r.byConf.map((x) => `<li>${CONF_NAME[x.conf]}: acertou ${pct(x.ok, x.n)} (${x.ok} de ${x.n})</li>`).join('') + '</ul>';
      add(h);
    }
    if (s.count) add(`<p class="font-bold text-slate-100">Contagem de peças</p><p class="text-slate-300 mt-1">O app contou certo em <strong class="text-emerald-300">${pct(s.count.ok, s.count.n)}</strong> das folhas conferidas (${s.count.ok} de ${s.count.n}).</p>`);
    document.getElementById('learnSync').textContent = s.pending ? `${s.pending} eventos ainda não enviados ao banco (enviam sozinhos com internet).` : s.events ? 'Todos os eventos estão salvos no banco.' : '';
  }

  function open() {
    render();
    document.getElementById('learnDialog').showModal();
    sync();
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(load(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `puzzlefinder-aprendizado-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  document.querySelectorAll('.js-learn').forEach((b) => b.addEventListener('click', open));
  document.getElementById('learnClose').addEventListener('click', () => document.getElementById('learnDialog').close());
  document.getElementById('learnExport').addEventListener('click', exportJson);
  window.addEventListener('online', sync);
  setTimeout(sync, 8000);

  return { log, stats, sync, open };
})();
