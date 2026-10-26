// ==========================================
// BANCO DE PEÇAS
// Todas as peças das fotos num lugar só, separadas como uma pessoa separa na mesa: por cor, por desenho e por tipo
// (borda, canto, miolo). Na aba "Montagem virtual" o app monta o quebra-cabeça com as peças nos lugares sugeridos.
// ==========================================
const Bank = (() => {
  const $ = (id) => document.getElementById(id);
  const K_GROUPS = 6;
  const f = { color: -1, kind: 'all', detail: 'all', status: 'loose', photo: -1, sort: 'cell' };
  let tab = 'pieces';
  let cellPx = 26;
  let incMaybe = true;
  const imgs = new Map();

  const api = () => Workspace.bankApi();
  const flatCount = (pc) => (pc.sides ? Object.values(pc.sides).filter((v) => v === 'flat').length : 0);
  const kindOf = (pc) => { const n = flatCount(pc); return n >= 2 ? 'corner' : n === 1 ? 'edge' : 'inner'; };
  const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rgbToHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  // k-means simples nas cores dominantes (Lab); o primeiro centro é a peça mais clara e os seguintes os mais distantes
  function colorGroups(pieces) {
    const pts = pieces.map((pc) => (pc.look && pc.look.colors[0]) || null);
    const idx = pieces.map((_, i) => i).filter((i) => pts[i]);
    pieces.forEach((pc) => { pc._cg = -1; });
    if (!idx.length) return [];
    const k = Math.min(K_GROUPS, idx.length);
    const lab = (i) => pts[i].lab;
    const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    let cent = [lab(idx.reduce((m, i) => (lab(i)[0] > lab(m)[0] ? i : m), idx[0]))];
    while (cent.length < k) {
      let best = idx[0], bd = -1;
      for (const i of idx) { const d = Math.min(...cent.map((c) => d2(lab(i), c))); if (d > bd) { bd = d; best = i; } }
      cent.push(lab(best));
    }
    cent = cent.map((c) => c.slice());
    let asg = [];
    for (let it = 0; it < 12; it++) {
      asg = idx.map((i) => { let b = 0, bd = Infinity; cent.forEach((c, j) => { const d = d2(lab(i), c); if (d < bd) { bd = d; b = j; } }); return b; });
      cent = cent.map((c, j) => {
        const m = idx.filter((_, n) => asg[n] === j);
        if (!m.length) return c;
        return [0, 1, 2].map((a) => m.reduce((s, i) => s + lab(i)[a], 0) / m.length);
      });
    }
    // grupos do mais claro ao mais escuro; amostra = média das cores exibidas
    const order = cent.map((c, j) => j).sort((a, b) => cent[b][0] - cent[a][0]);
    const rank = new Map(order.map((j, r) => [j, r]));
    const groups = order.map(() => ({ n: 0, rgb: [0, 0, 0] }));
    idx.forEach((i, n) => {
      const g = rank.get(asg[n]);
      pieces[i]._cg = g;
      const rgb = hexToRgb(pts[i].hex);
      groups[g].n++;
      groups[g].rgb = groups[g].rgb.map((v, a) => v + rgb[a]);
    });
    return groups.map((g, i) => ({ id: i, n: g.n, hex: g.n ? rgbToHex(g.rgb.map((v) => v / g.n)) : '#334155' })).filter((g) => g.n);
  }

  // Liso × desenhado é relativo às peças deste quebra-cabeça (terços), porque a variação depende da foto
  function detailCuts(pieces) {
    const v = pieces.map((p) => p.look && p.look.spread).filter((x) => x != null).sort((a, b) => a - b);
    if (v.length < 3) return [0, Infinity];
    return [v[Math.floor(v.length / 3)], v[Math.floor((2 * v.length) / 3)]];
  }

  function info(pc) {
    const { placeOf, placed } = api();
    const pl = placed.has(pc.id) ? null : placeOf(pc);
    return { placed: placed.has(pc.id), pl };
  }

  function filtered(pieces, cuts) {
    return pieces.filter((pc) => {
      const { placed } = info(pc);
      if (f.status === 'loose' && placed) return false;
      if (f.status === 'placed' && !placed) return false;
      if (f.color >= 0 && pc._cg !== f.color) return false;
      if (f.kind !== 'all' && kindOf(pc) !== f.kind) return false;
      if (f.photo >= 0 && pc.photo !== f.photo) return false;
      if (f.detail !== 'all') {
        const s = pc.look ? pc.look.spread : null;
        if (s == null) return false;
        if (f.detail === 'plain' && s > cuts[0]) return false;
        if (f.detail === 'busy' && s < cuts[1]) return false;
      }
      return true;
    });
  }

  function chips(host, items, cur, on) {
    host.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip ${cur === it.v ? 'chip-sure' : 'chip-low'} !h-9 shrink-0`;
      b.setAttribute('aria-pressed', String(cur === it.v));
      if (it.hex) {
        const s = document.createElement('span');
        s.style.cssText = `width:1rem;height:1rem;border-radius:999px;background:${it.hex};box-shadow:0 0 0 1.5px rgb(255 255 255 / .5)`;
        b.appendChild(s);
      }
      b.appendChild(document.createTextNode(it.label));
      b.addEventListener('click', () => { on(it.v); render(); });
      host.appendChild(b);
    }
  }

  function renderPieces(pieces, groups, cuts) {
    const p = currentPuzzle;
    chips($('bankColors'), [{ v: -1, label: 'Todas as cores' }, ...groups.map((g) => ({ v: g.id, hex: g.hex, label: String(g.n) }))], f.color, (v) => { f.color = v; });
    const kinds = { corner: 0, edge: 0, inner: 0 };
    pieces.forEach((pc) => kinds[kindOf(pc)]++);
    chips($('bankKinds'), [{ v: 'all', label: 'Todos os tipos' }, { v: 'corner', label: `Canto ${kinds.corner}` }, { v: 'edge', label: `Borda ${kinds.edge}` }, { v: 'inner', label: `Miolo ${kinds.inner}` }], f.kind, (v) => { f.kind = v; });
    chips($('bankDetail'), [{ v: 'all', label: 'Qualquer desenho' }, { v: 'plain', label: 'Mais lisas' }, { v: 'busy', label: 'Mais desenhadas' }], f.detail, (v) => { f.detail = v; });
    chips($('bankStatus'), [{ v: 'loose', label: 'Soltas' }, { v: 'placed', label: 'Encaixadas' }, { v: 'all', label: 'Todas' }], f.status, (v) => { f.status = v; });
    const nPhotos = new Set(pieces.map((pc) => pc.photo)).size;
    const photoItems = nPhotos > 1 ? [{ v: -1, label: 'Todas as fotos' }, ...[...new Set(pieces.map((pc) => pc.photo))].sort().map((v) => ({ v, label: `Foto ${v + 1}` }))] : [];
    chips($('bankPhotos'), photoItems, f.photo, (v) => { f.photo = v; });
    chips($('bankSort'), [{ v: 'cell', label: 'Ordem do mapa' }, { v: 'color', label: 'Por cor' }], f.sort, (v) => { f.sort = v; });

    const list = filtered(pieces, cuts);
    const cellOf = (pc) => { const { pl } = info(pc); return pl && pl.cand ? pl.cand.row * p.cols + pl.cand.col : 1e9; };
    if (f.sort === 'color') list.sort((a, b) => (a._cg === -1) - (b._cg === -1) || a._cg - b._cg || ((a.look && a.look.tone) || 0) - ((b.look && b.look.tone) || 0));
    else list.sort((a, b) => cellOf(a) - cellOf(b));
    $('bankCount').textContent = `${list.length} de ${pieces.length} peças`;
    const grid = $('bankGrid');
    grid.innerHTML = '';
    for (const pc of list.slice(0, 400)) {
      const { placed, pl } = info(pc);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'relative rounded-lg overflow-hidden bg-slate-900 ring-1 ring-inset ring-slate-700 aspect-square';
      const im = document.createElement('img');
      im.src = `data:image/jpeg;base64,${pc.thumb_base64}`;
      im.alt = 'Peça';
      im.className = 'w-full h-full object-contain';
      b.appendChild(im);
      const tag = document.createElement('span');
      tag.className = 'absolute left-0.5 bottom-0.5 px-1.5 rounded-md text-[10px] font-bold ' + (placed ? 'bg-emerald-400 text-slate-950' : pl && pl.conf === 'sure' ? 'bg-emerald-400/90 text-slate-950' : pl && pl.conf === 'maybe' ? 'bg-amber-400/90 text-slate-950' : 'bg-slate-700 text-slate-200');
      tag.textContent = placed ? '✓' : pl && pl.cand ? `nº ${Grid.cellNumber(pl.cand.col, pl.cand.row, p.cols)}` : '?';
      b.appendChild(tag);
      if (pc.look && pc.look.colors[0]) {
        const sw = document.createElement('span');
        sw.className = 'absolute right-0.5 top-0.5 w-3.5 h-3.5 rounded-full ring-1 ring-white/60';
        sw.style.background = pc.look.colors[0].hex;
        b.appendChild(sw);
      }
      b.addEventListener('click', () => api().openLocate(pc));
      grid.appendChild(b);
    }
    if (list.length > 400) $('bankCount').textContent += ' · mostrando as 400 primeiras: use os filtros';
  }

  function img(pc) {
    let im = imgs.get(pc.id);
    if (!im) { im = new Image(); im.src = `data:image/jpeg;base64,${pc.thumb_base64}`; im.onload = () => { if (tab === 'virtual') renderVirtual(); }; imgs.set(pc.id, im); }
    return im;
  }

  let vmap = []; // [{x,y,w,h,piece}] para o toque na montagem virtual

  function renderVirtual() {
    const p = currentPuzzle;
    const { pieces, placeOf, placed } = api();
    const canvas = $('bankCanvas');
    const cw = cellPx, ch = cellPx * (grid.art.height / p.rows) / (grid.art.width / p.cols);
    canvas.width = Math.round(cw * p.cols);
    canvas.height = Math.round(ch * p.rows);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(grid.art, 0, 0, canvas.width, canvas.height);
    // células que faltam: arte escurecida; as montadas ficam como a arte
    ctx.fillStyle = 'rgba(2, 6, 23, 0.72)';
    for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) {
      if (!grid.scanMap || grid.scanMap[r * p.cols + c] !== '1') ctx.fillRect(c * cw, r * ch, cw, ch);
    }
    vmap = [];
    let sure = 0, maybe = 0;
    const used = new Set();
    const list = pieces.filter((pc) => !placed.has(pc.id)).map((pc) => ({ pc, pl: placeOf(pc) }))
      .filter(({ pl }) => pl.cand && !pl.disputed && (pl.conf === 'sure' || (incMaybe && pl.conf === 'maybe')));
    for (const { pc, pl } of list) {
      const cell = pl.cand.row * p.cols + pl.cand.col;
      if (used.has(cell) || (grid.scanMap && grid.scanMap[cell] === '1')) continue;
      used.add(cell);
      pl.conf === 'sure' ? sure++ : maybe++;
      const x = pl.cand.col * cw, y = pl.cand.row * ch;
      const im = img(pc);
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, cw, ch); ctx.clip();
      if (im.complete && im.naturalWidth) {
        const body = (pc.look && pc.look.body) || 0.7;
        const k = (cw / body) / Math.max(im.naturalWidth, im.naturalHeight);
        ctx.translate(x + cw / 2, y + ch / 2);
        ctx.rotate((pl.cand.rotation_deg * Math.PI) / 180);
        ctx.drawImage(im, (-im.naturalWidth * k) / 2, (-im.naturalHeight * k) / 2, im.naturalWidth * k, im.naturalHeight * k);
      }
      ctx.restore();
      ctx.lineWidth = Math.max(1.5, cw / 14);
      ctx.strokeStyle = pl.conf === 'sure' ? '#34d399' : '#fbbf24';
      ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, cw - ctx.lineWidth, ch - ctx.lineWidth);
      vmap.push({ x, y, w: cw, h: ch, pc });
    }
    const missing = grid.scanMap ? [...grid.scanMap].filter((v) => v !== '1').length : p.cols * p.rows;
    $('bankVirtualInfo').textContent = `${sure + maybe} peças montadas virtualmente (${sure} certas${incMaybe ? `, ${maybe} talvez` : ''}) · ${Math.max(0, missing - sure - maybe)} células ainda sem peça. Toque numa peça para comparar.`;
    $('bankMaybe').setAttribute('aria-pressed', String(incMaybe));
    $('bankMaybe').textContent = incMaybe ? 'Com as "talvez"' : 'Só as certas';
  }

  function render() {
    if (!$('bankDialog').open || !currentPuzzle) return;
    const { pieces } = api();
    const groups = colorGroups(pieces);
    const cuts = detailCuts(pieces);
    $('bankPane-pieces').classList.toggle('hidden', tab !== 'pieces');
    $('bankPane-virtual').classList.toggle('hidden', tab !== 'virtual');
    $('bankTab-pieces').setAttribute('aria-selected', String(tab === 'pieces'));
    $('bankTab-virtual').setAttribute('aria-selected', String(tab === 'virtual'));
    if (tab === 'pieces') renderPieces(pieces, groups, cuts); else renderVirtual();
  }

  function open() {
    if (!api().pieces.length) return;
    $('bankDialog').showModal();
    render();
  }

  $('btnBank').addEventListener('click', open);
  $('bankClose').addEventListener('click', () => $('bankDialog').close());
  for (const t of ['pieces', 'virtual']) $(`bankTab-${t}`).addEventListener('click', () => { tab = t; render(); });
  $('bankMaybe').addEventListener('click', () => { incMaybe = !incMaybe; renderVirtual(); });
  $('bankZoomIn').addEventListener('click', () => { cellPx = Math.min(80, cellPx + 8); renderVirtual(); });
  $('bankZoomOut').addEventListener('click', () => { cellPx = Math.max(12, cellPx - 8); renderVirtual(); });
  $('bankCanvas').addEventListener('click', (ev) => {
    const r = $('bankCanvas').getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * $('bankCanvas').width, y = ((ev.clientY - r.top) / r.height) * $('bankCanvas').height;
    const hit = vmap.find((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
    if (hit) api().openLocate(hit.pc);
  });
  $('compareDialog').addEventListener('close', render);

  return { open, render };
})();
