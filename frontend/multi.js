// ==========================================
// BUSCA MÚLTIPLA (fila de buscas)
// Monte uma fila com várias peças do mapa e deixe o app buscar uma depois da outra nas fotos. Cada resultado fica
// na lista para você conferir quando quiser. No servidor, as buscas de todas as pessoas do projeto também esperam
// a vez (ver Search: "Na fila do servidor").
// ==========================================
const Multi = (() => {
  const $ = (id) => document.getElementById(id);
  const items = [];   // { col, row, status: 'wait'|'run'|'done'|'none'|'err', data, more, remaining, msg }
  let running = false;
  const same = (a, b) => a.col === b.col && a.row === b.row;
  const num = (it) => Grid.cellNumber(it.col, it.row, currentPuzzle.cols);

  function add(cell) {
    if (!cell || items.some((i) => same(i, cell))) return false;
    items.push({ col: cell.col, row: cell.row, status: 'wait' });
    return true;
  }

  function addNumbers(text) {
    const p = currentPuzzle;
    let n = 0, bad = [];
    for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
      const v = parseInt(part, 10);
      if (!(v >= 1 && v <= p.cols * p.rows)) { bad.push(part); continue; }
      if (add(Grid.cellFromNumber(v, p.cols))) n++;
    }
    if (bad.length) notify(`Fora do quebra-cabeça: ${bad.join(', ')}.`, 'info');
    return n;
  }

  const chipOf = (it) => {
    if (it.status === 'wait') return ['chip-low', 'Na fila'];
    if (it.status === 'run') return ['chip-maybe', 'Buscando…'];
    if (it.status === 'none') return ['chip-low', 'Nenhuma parecida'];
    if (it.status === 'err') return ['chip-low', 'Erro'];
    return it.data.confident ? ['chip-sure', 'Muito provável'] : ['chip-maybe', 'Possível'];
  };

  function render() {
    const list = $('multiList');
    list.innerHTML = '';
    $('multiCard').classList.toggle('hidden', !items.length && !$('multiOpen').open);
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-2 py-2 border-b border-slate-800 last:border-0';
      const t = document.createElement('span');
      t.className = 'flex-1 min-w-0 text-sm text-slate-200';
      t.textContent = `Peça nº ${num(it)} · coluna ${it.col + 1}, linha ${it.row + 1}`;
      const [cls, label] = chipOf(it);
      const chip = document.createElement('span');
      chip.className = `chip ${cls} shrink-0`;
      chip.textContent = label;
      li.append(t, chip);
      if (it.status === 'done') {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn-quiet !h-9 !px-3 shrink-0'; b.textContent = 'Ver';
        b.addEventListener('click', () => Workspace.openFindResults(it.data, { col: it.col, row: it.row }, { remaining: it.remaining, more: it.more }));
        li.appendChild(b);
      }
      if (!running) {
        const x = document.createElement('button');
        x.type = 'button'; x.setAttribute('aria-label', 'Tirar da fila'); x.className = 'w-8 h-8 shrink-0 text-slate-400 hover:text-white';
        x.innerHTML = '<svg class="icon w-4 h-4"><use href="#i-x"/></svg>';
        x.addEventListener('click', () => { items.splice(items.indexOf(it), 1); render(); });
        li.appendChild(x);
      }
      list.appendChild(li);
    }
    const waiting = items.filter((i) => i.status === 'wait' || i.status === 'err').length;
    $('multiRun').disabled = running || !waiting;
    $('multiRun').textContent = running ? 'Buscando…' : waiting ? `Buscar ${waiting} ${waiting === 1 ? 'peça' : 'peças'} da fila` : 'Fila vazia';
    $('multiClear').disabled = running || !items.length;
  }

  // As funções do app leem grid.cell: aponta para a célula da vez e devolve no fim
  async function withCell(cell, fn) {
    const saved = grid.cell;
    grid.cell = { col: cell.col, row: cell.row };
    try { return await fn(); } finally { grid.cell = saved; }
  }

  async function run() {
    if (running) return;
    const active = tablePhotos.filter((p) => !p.done);
    if (!active.length) { notify('Anexe as fotos das peças soltas (que ainda não foram concluídas).', 'info'); return; }
    running = true;
    $('btnFind').disabled = true;
    render();
    try {
      if (apiWakeup) await apiWakeup;
      for (const it of items.filter((i) => i.status === 'wait' || i.status === 'err')) {
        it.status = 'run';
        render();
        try {
          const build = (chunk) => withCell(it, () => buildFindCellForm(chunk, { annotate: false }));
          const parts = [];
          const stopWhen = (ps) => Boolean((Search.mergeFindCell(ps) || {}).confident);
          const first = await Search.run('/api/find-cell', active, build, { parts, errorText: 'Não foi possível buscar esta peça.', stopWhen });
          it.data = Search.mergeFindCell(parts);
          it.remaining = first.remaining.length;
          it.more = first.remaining.length ? async () => {
            const r = await Search.run('/api/find-cell', active, build, { parts, errorText: 'Não foi possível buscar esta peça.' });
            return { data: Search.mergeFindCell(parts), remaining: r.remaining.length };
          } : null;
          it.status = it.data && it.data.candidates && it.data.candidates.length ? 'done' : 'none';
        } catch (err) {
          it.status = 'err';
          it.msg = err.message;
          if (/sessão expirou/.test(err.message)) break;
        }
        render();
      }
    } finally {
      running = false;
      $('btnFind').disabled = false;
      if (typeof checkReady === 'function') checkReady();
      render();
      const done = items.filter((i) => i.status === 'done').length;
      notify(`Busca múltipla pronta: ${done} de ${items.length} com candidatas. Toque em "Ver" para conferir.`, 'success', 7000);
    }
  }

  $('multiAddCurrent').addEventListener('click', () => {
    if (!grid.cell) { notify('Escolha uma peça no mapa (ou digite coluna e linha) primeiro.', 'info'); return; }
    notify(add(grid.cell) ? 'Peça na fila.' : 'Essa peça já está na fila.', 'info', 2500);
    render();
  });
  $('multiAddNumbers').addEventListener('click', () => {
    const n = addNumbers($('multiNumbers').value);
    $('multiNumbers').value = '';
    if (n) notify(`${n} ${n === 1 ? 'peça' : 'peças'} na fila.`, 'info', 2500);
    render();
  });
  $('multiNumbers').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('multiAddNumbers').click(); } });
  $('multiRun').addEventListener('click', run);
  $('multiClear').addEventListener('click', () => { items.splice(0); render(); });
  $('multiOpen').addEventListener('toggle', render);
  render();

  return { add, render };
})();
