// ==========================================
// ÁREA DE TRABALHO DO MAPA
// Assistente de preparação (caixa → tabuleiro → peças), abas buraco → peça / peças → mapa,
// peças localizadas agrupadas por região e a tela de comparar e confirmar.
// Usa o estado de app.js (grid, currentPuzzle, tablePhotos…), carregado antes deste arquivo.
// ==========================================
const Workspace = (() => {
  const $ = (id) => document.getElementById(id);
  const STEPS = ['stepBox', 'stepBoard', 'stepPieces'];
  // Mesmo limiar do servidor (grid_engine.LOCATE_CONFIDENT, em %): "vai aqui"
  const SURE = 90;
  const MAYBE = 60;
  const ZONE_ROWS = ['Alto', 'Meio', 'Baixo'];
  const ZONE_COLS = ['à esquerda', 'no centro', 'à direita'];

  const state = {
    mode: 'find',
    located: null,        // resposta de /api/locate-pieces
    locatedFor: null,     // assinatura das fotos usadas (fotos mudaram → localizar de novo)
    rejected: new Set(),  // "id:col,row" recusados na comparação
    placedPieces: new Set(),
    cmp: null,            // comparação aberta
    photoZoom: false,     // "ver na foto": foto inteira (padrão) ou de perto
    bitmaps: new Map(),   // foto das peças → ImageBitmap (para o recorte "ver na foto")
    opened: null,         // passo do assistente aberto
  };

  // ---------- Blocos compartilhados: fotos das peças e botões de busca ----------
  function onGridMode(on) {
    (on ? $('photosSlotGrid') : $('photosSlotLegacy')).appendChild($('photosBlock'));
    (on ? $('findSlotGrid') : $('findSlotLegacy')).appendChild($('findControls'));
    $('setupWizard').classList.toggle('hidden', !on);
    $('checkTarget').querySelector('span').textContent = on ? 'Escolha a peça no mapa' : 'Marque um ponto na caixa';
    state.located = null;
    state.rejected.clear();
    state.placedPieces.clear();
    renderLocate();
    setMode('find');
    refresh({ autoOpen: true });
  }

  // ---------- Assistente ----------
  function stepDone() {
    return { stepBox: Boolean(grid.art), stepBoard: Boolean(grid.scanMap), stepPieces: tablePhotos.length > 0 };
  }

  function refresh({ autoOpen = false } = {}) {
    const p = currentPuzzle;
    if (!p || !isGridPuzzle(p)) return;
    const done = stepDone();
    const firstTodo = STEPS.find((s) => !done[s]) || null;
    STEPS.forEach((id) => { $(id).dataset.state = done[id] ? 'done' : id === firstTodo ? 'current' : 'todo'; });

    const total = p.cols * p.rows;
    $('stepBoxStatus').textContent = grid.art ? `Mapa de ${p.cols} × ${p.rows} = ${total} peças`
      : grid.boxBitmap ? 'Marque os 4 cantos da arte' : 'Carregando a foto da caixa…';
    $('btnEditCorners').classList.toggle('hidden', !grid.art);
    if (grid.scanMap) {
      const placed = countPlaced(grid.scanMap);
      const when = p.scanned_at ? ` · ${new Date(p.scanned_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}` : '';
      $('stepBoardStatus').textContent = `${placed} montadas · ${total - placed} faltam${when}`;
    } else {
      $('stepBoardStatus').textContent = 'Fotografe o que já está montado';
    }
    const n = tablePhotos.length;
    $('stepPiecesStatus').textContent = n ? `${n} ${n === 1 ? 'foto' : 'fotos'} nesta sessão` : 'Fotos sobre folha branca';
    const count = Object.values(done).filter(Boolean).length;
    $('wizardProgress').textContent = count === 3 ? 'Pronto' : `${count} de 3`;

    renderCalib();
    $('btnLocate').disabled = !(grid.art && n);
    $('btnLocateText').textContent = n ? `Localizar as peças ${n === 1 ? 'da foto' : `das ${n} fotos`}` : 'Localizar as peças das fotos';
    if (autoOpen) openStep(firstTodo);
  }

  function openStep(id) {
    state.opened = id;
    STEPS.forEach((s) => {
      const open = s === id;
      $(s).querySelector('.wz-head').setAttribute('aria-expanded', String(open));
      $(`${s}Body`).hidden = !open;
    });
  }

  STEPS.forEach((s) => {
    $(s).querySelector('.wz-head').addEventListener('click', () => openStep(state.opened === s ? null : s));
  });
  $('btnBoxPhoto').addEventListener('click', () => $('btnEditPuzzle').click());

  function onScanned() {
    refresh({ autoOpen: true });
    renderLocate();
    renderMarks();
  }

  function onPhotosChanged() {
    refresh();
    if (state.located && state.locatedFor !== photosSignature()) {
      $('locateIntro').textContent = 'As fotos mudaram. Localize de novo para incluir as peças novas.';
    }
  }

  const photosSignature = () => tablePhotos.map((p) => p.url).join('|');

  // ---------- Abas ----------
  const tabs = { find: $('tabFind'), locate: $('tabLocate') };

  function setMode(mode) {
    state.mode = mode;
    for (const [m, tab] of Object.entries(tabs)) {
      const on = m === mode;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    $('panelFind').hidden = mode !== 'find';
    $('panelLocate').hidden = mode !== 'locate';
    $('mapLegend').textContent = mode === 'find'
      ? 'Claras ainda faltam; escurecidas já estão montadas. Toque na que você procura.'
      : 'Verde: a peça vai aqui. Âmbar: talvez. Toque numa marca para comparar.';
    $('mapPin').classList.toggle('hidden', mode !== 'find' || !grid.cell);
    renderMarks();
  }

  tabs.find.addEventListener('click', () => setMode('find'));
  tabs.locate.addEventListener('click', () => setMode('locate'));
  $('tabFind').parentElement.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = state.mode === 'find' ? 'locate' : 'find';
    setMode(next);
    tabs[next].focus();
  });

  // ---------- Peças → mapa ----------
  $('btnLocate').addEventListener('click', locate);

  async function locate() {
    if (!tablePhotos.length || !grid.art) return;
    const p = currentPuzzle;
    const btn = $('btnLocate');
    btn.disabled = true;
    show($('locateLoading'), 'flex');
    $('locateLoadingText').textContent = serviceStatus.api === 'ok'
      ? `Separando as peças de ${tablePhotos.length === 1 ? '1 foto' : `${tablePhotos.length} fotos`} e comparando com a caixa…`
      : 'Acordando o servidor… a primeira busca do dia pode levar até 1 minuto.';
    try {
      const blobs = tablePhotos.map((t) => t.blob);
      const calib = calibPayload();
      const buildForm = (chunk) => {
        const form = new FormData();
        appendTablePhotos(form, chunk);
        form.append('box_file', grid.artBlob, 'art.jpg');
        form.append('cols', p.cols);
        form.append('rows', p.rows);
        form.append('top_k', '5');
        if (grid.scanMap) form.append('scan_map', grid.scanMap);
        if (calib.length) form.append('calib', JSON.stringify(calib));
        if (p.width_cm > 0) form.append('piece_mm', String((p.width_cm * 10) / p.cols));
        return form;
      };
      if (apiWakeup) await apiWakeup;
      const parts = await postPhotosInBatches('/api/locate-pieces', blobs, buildForm, {
        timeoutMs: 240000,
        errorText: 'Não foi possível localizar as peças.',
        onBatch: (from, to, total) => {
          if (total > PHOTOS_PER_REQUEST) $('locateLoadingText').textContent = `Separando as peças das fotos ${from + 1}–${to} de ${total} e comparando com a caixa…`;
        },
      });
      // Junta os lotes: id e número da foto passam a valer para a sessão inteira
      state.located = {
        ...parts[0].data,
        pieces: parts.flatMap(({ offset, data }) => data.pieces.map((pc) => ({ ...pc, id: `${offset}-${pc.id}`, photo: pc.photo + offset }))),
        pieces_detected: parts.reduce((n, x) => n + (x.data.pieces_detected || 0), 0),
        photos: mergedPhotos(parts, blobs.length),
      };
      state.locatedFor = photosSignature();
      state.rejected.clear();
      state.placedPieces.clear();
      // Peça já confirmada que continua nas fotos: mesma assinatura → já está encaixada
      const confirmedSigs = new Set(calibLoad().map((p) => p.sig));
      for (const piece of state.located.pieces) if (piece.sig && confirmedSigs.has(piece.sig)) state.placedPieces.add(piece.id);
      setServiceStatus('api', 'ok', 'Online');
      $('locateIntro').textContent = 'Toque numa peça (ou numa marca do mapa) para comparar com a caixa e confirmar.';
      renderLocate();
      renderMarks();
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    } catch (err) {
      notify(err.name === 'AbortError' ? 'O servidor demorou demais. Tente de novo em instantes.' : err.message, 'error', 7000);
    } finally {
      hide($('locateLoading'), 'flex');
      btn.disabled = !(grid.art && tablePhotos.length);
    }
  }

  // Candidatas de uma peça ainda válidas: não recusadas e numa célula que continua faltando
  function liveCandidates(piece) {
    return piece.candidates.filter((c) => !state.rejected.has(`${piece.id}:${c.col},${c.row}`)
      && !(grid.scanMap && grid.scanMap[c.row * currentPuzzle.cols + c.col] === '1'));
  }

  function confidence(piece, cand) {
    if (!cand) return 'low';
    if (cand === piece.candidates[0] && piece.confident) return 'sure';
    return cand.score >= MAYBE ? 'maybe' : 'low';
  }

  function zoneOf(col, row) {
    const p = currentPuzzle;
    return [Math.min(2, Math.floor((row * 3) / p.rows)), Math.min(2, Math.floor((col * 3) / p.cols))];
  }

  function zoneName([zr, zc]) {
    return zr === 1 && zc === 1 ? 'Centro' : `${ZONE_ROWS[zr]} ${ZONE_COLS[zc]}`;
  }

  function zoneGlyph(zone) {
    const g = document.createElement('span');
    g.className = 'zone';
    g.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 9; i++) {
      const c = document.createElement('i');
      if (zone && Math.floor(i / 3) === zone[0] && i % 3 === zone[1]) c.className = 'on';
      g.appendChild(c);
    }
    return g;
  }

  function renderLocate() {
    const summary = $('locateSummary');
    const groupsEl = $('locateGroups');
    groupsEl.innerHTML = '';
    const data = state.located;
    if (!data) { hide(summary, 'flex'); return; }

    // Grupos: bordas (lados retos) primeiro, depois as regiões do mapa, e as sem lugar claro por último
    const groups = new Map();
    const add = (key, title, zone, piece, cand, conf) => {
      if (!groups.has(key)) groups.set(key, { title, zone, items: [] });
      groups.get(key).items.push({ piece, cand, conf });
    };
    let sure = 0, maybe = 0, low = 0, done = 0;
    for (const piece of data.pieces) {
      if (state.placedPieces.has(piece.id)) { done++; continue; }
      const cand = liveCandidates(piece)[0];
      const conf = confidence(piece, cand);
      if (conf === 'sure') sure++; else if (conf === 'maybe') maybe++; else low++;
      // Borda: lado reto E a célula provável está na borda do quebra-cabeça
      const isEdge = cand && piece.sides && Object.values(piece.sides).includes('flat')
        && (cand.col === 0 || cand.row === 0 || cand.col === currentPuzzle.cols - 1 || cand.row === currentPuzzle.rows - 1);
      if (!cand || conf === 'low') add('low', 'Sem lugar claro', null, piece, cand, conf);
      else if (isEdge) add('edge', 'Bordas', null, piece, cand, conf);
      else {
        const zone = zoneOf(cand.col, cand.row);
        add(`z${zone[0]}${zone[1]}`, zoneName(zone), zone, piece, cand, conf);
      }
    }

    summary.innerHTML = '';
    const chip = (cls, text) => { const s = document.createElement('span'); s.className = `chip ${cls}`; s.textContent = text; summary.appendChild(s); };
    chip('chip-sure', `${sure} ${sure === 1 ? 'vai' : 'vão'} aqui`);
    chip('chip-maybe', `${maybe} talvez`);
    chip('chip-low', `${low} sem lugar claro`);
    if (done) chip('chip-sure', `${done} ${done === 1 ? 'encaixada' : 'encaixadas'}`);
    show(summary, 'flex');

    const order = [...groups.entries()].sort(([ka, a], [kb, b]) => {
      const rank = (k) => (k === 'edge' ? 0 : k === 'low' ? 2 : 1);
      return rank(ka) - rank(kb) || b.items.length - a.items.length;
    });
    for (const [key, g] of order) {
      const sec = document.createElement('section');
      sec.className = 'panel';
      const head = document.createElement('div');
      head.className = 'flex items-center gap-2.5 mb-3';
      if (g.zone) head.appendChild(zoneGlyph(g.zone));
      const h = document.createElement('h3');
      h.className = 'font-bold text-[15px]';
      h.textContent = g.title;
      const count = document.createElement('span');
      count.className = 'ml-auto text-xs text-slate-400 tabular-nums';
      const sureHere = g.items.filter((it) => it.conf === 'sure').length;
      count.textContent = `${g.items.length} ${g.items.length === 1 ? 'peça' : 'peças'}${sureHere ? ` · ${sureHere} ${sureHere === 1 ? 'certa' : 'certas'}` : ''}`;
      head.append(h, count);
      if (key === 'low') {
        const hint = document.createElement('p');
        hint.className = 'text-xs text-slate-400 -mt-2 mb-3';
        hint.textContent = 'A cor e o desenho não apontaram uma célula só. Abra para ver as 5 mais parecidas.';
        sec.append(head, hint);
      } else {
        sec.appendChild(head);
      }
      const list = document.createElement('div');
      list.className = 'flex flex-wrap gap-2';
      g.items.sort((a, b) => (b.cand ? b.cand.score : 0) - (a.cand ? a.cand.score : 0));
      for (const { piece, cand, conf } of g.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tile';
        b.dataset.conf = conf;
        const n = cand ? Grid.cellNumber(cand.col, cand.row, currentPuzzle.cols) : null;
        b.setAttribute('aria-label', cand ? `Peça da foto ${piece.photo + 1}: provável nº ${n}` : `Peça da foto ${piece.photo + 1}: sem lugar provável`);
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = `data:image/jpeg;base64,${piece.thumb_base64}`;
        if (cand) img.style.transform = `rotate(${cand.rotation_deg}deg)`;
        b.appendChild(img);
        if (state.located.photos && state.located.photos.length > 1) {
          const ph = document.createElement('span');
          ph.className = 'tile-photo';
          ph.textContent = `F${piece.photo + 1}`;
          b.appendChild(ph);
        }
        if (n) {
          const tag = document.createElement('span');
          tag.className = 'tile-tag';
          tag.textContent = n;
          b.appendChild(tag);
        }
        b.addEventListener('click', () => openLocate(piece));
        list.appendChild(b);
      }
      sec.appendChild(list);
      groupsEl.appendChild(sec);
    }
  }

  // Marcas no mapa: uma por peça, na célula mais provável
  function renderMarks() {
    const layer = $('mapMarks');
    layer.innerHTML = '';
    if (state.mode !== 'locate' || !state.located || !currentPuzzle) return;
    const { cols, rows } = currentPuzzle;
    const active = state.cmp && state.cmp.kind === 'locate' ? state.cmp.piece.id : null;
    for (const piece of state.located.pieces) {
      if (state.placedPieces.has(piece.id)) continue;
      const cand = liveCandidates(piece)[0];
      const conf = confidence(piece, cand);
      if (!cand || conf === 'low') continue;
      const m = document.createElement('div');
      m.className = `mark ${piece.id === active ? 'mark-active' : conf === 'sure' ? 'mark-sure' : 'mark-maybe'}`;
      m.style.left = `${(cand.col / cols) * 100}%`;
      m.style.top = `${(cand.row / rows) * 100}%`;
      m.style.width = `${100 / cols}%`;
      m.style.height = `${100 / rows}%`;
      layer.appendChild(m);
    }
  }

  // Toque no mapa: na aba peças → mapa abre a peça que aponta para a célula. true = tratado aqui
  function onMapTap(col, row) {
    if (state.mode !== 'locate') return false;
    if (!state.located) {
      notify('Localize as peças das fotos primeiro.', 'info');
      return true;
    }
    $('mapPin').classList.add('hidden');
    // A célula tem poucos pixels no celular: aceita a marca mais próxima a até 1 célula do toque
    let best = null;
    for (const piece of state.located.pieces) {
      if (state.placedPieces.has(piece.id)) continue;
      const cand = liveCandidates(piece)[0];
      if (!cand || confidence(piece, cand) === 'low') continue;
      const d = Math.max(Math.abs(cand.col - col), Math.abs(cand.row - row));
      if (d > 1) continue;
      if (!best || d < best.d || (d === best.d && cand.score > best.cand.score)) best = { piece, cand, d };
    }
    if (best) openLocate(best.piece);
    else notify(`Nenhuma peça das fotos aponta para a nº ${Grid.cellNumber(col, row, currentPuzzle.cols)}.`, 'info');
    return true;
  }

  // ---------- Aprendizado: cada peça confirmada ensina a diferença de cor entre fotos e caixa ----------
  // Guarda a assinatura de cor da peça (vinda do servidor) com a célula e o giro confirmados;
  // as buscas seguintes mandam esses pares e o servidor calibra a cor por eles.
  const CALIB_MAX = 60;
  const calibKey = () => `pf_calib_${currentPuzzle.id}`;

  function calibLoad() {
    if (!currentPuzzle) return [];
    try {
      const v = JSON.parse(localStorage.getItem(calibKey()) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (_) { return []; }
  }

  function calibSave(list) {
    try { localStorage.setItem(calibKey(), JSON.stringify(list.slice(-CALIB_MAX))); } catch (_) { /* sem espaço: segue sem aprender */ }
    renderCalib();
  }

  function calibAdd(sig, cell, rotation) {
    if (!sig || !currentPuzzle) return;
    const list = calibLoad().filter((p) => !(p.col === cell.col && p.row === cell.row));
    // Cada câmera reproduz as cores de um jeito: o par guarda de qual celular veio a foto
    list.push({ sig, col: cell.col, row: cell.row, rotation, camera: Camera.modelKey() });
    calibSave(list);
  }

  // Pares deste quebra-cabeça tirados com o celular atual (ou de antes de o modelo ser conhecido)
  function calibPayload() {
    if (!currentPuzzle || !isGridPuzzle(currentPuzzle)) return [];
    const cam = Camera.modelKey();
    return calibLoad()
      .filter((p) => !cam || !p.camera || p.camera === cam)
      .map(({ sig, col, row, rotation }) => ({ sig, col, row, rotation }));
  }

  function renderCalib() {
    const n = calibPayload().length;
    $('calibInfo').classList.toggle('hidden', !n);
    $('calibText').textContent = n === 1 ? 'A cor já é ajustada por 1 peça que você confirmou.'
      : `A cor já é ajustada por ${n} peças que você confirmou.`;
  }

  $('btnCalibReset').addEventListener('click', () => {
    try { localStorage.removeItem(calibKey()); } catch (_) {}
    renderCalib();
    notify('Ajuste de cor esquecido. As próximas confirmações recomeçam o aprendizado.', 'info');
  });

  // ---------- Comparar e confirmar ----------
  const dlg = $('compareDialog');

  // Buraco → peça: a célula é fixa, as candidatas são peças das fotos
  function openFindResults(data, cell) {
    if (!data.candidates || !data.candidates.length) {
      notify('Nenhuma peça parecida nas fotos.', 'info');
      return;
    }
    state.cmp = { kind: 'find', cell, items: data.candidates, index: 0, confident: data.confident, hole: data.hole, photos: data.photos };
    state.photoZoom = false;
    renderCompare();
    dlg.showModal();
  }

  // Peças → mapa: a peça é fixa, as candidatas são células
  function openLocate(piece) {
    const items = liveCandidates(piece);
    if (!items.length) {
      notify('Todas as células sugeridas para esta peça foram recusadas ou já estão montadas.', 'info');
      return;
    }
    state.cmp = { kind: 'locate', piece, items, index: 0 };
    state.photoZoom = false;
    renderCompare();
    renderMarks();
    dlg.showModal();
  }

  function cmpCell() {
    const c = state.cmp;
    return c.kind === 'find' ? c.cell : { col: c.items[c.index].col, row: c.items[c.index].row };
  }

  function renderCompare() {
    const c = state.cmp;
    const p = currentPuzzle;
    const item = c.items[c.index];
    const cell = cmpCell();
    const n = Grid.cellNumber(cell.col, cell.row, p.cols);
    const conf = c.kind === 'find'
      ? (c.index === 0 && c.confident ? 'sure' : item.score >= 70 ? 'maybe' : 'low')
      : confidence(c.piece, item);
    const zone = zoneName(zoneOf(cell.col, cell.row)).toLowerCase();

    if (c.kind === 'find') {
      $('cmpKicker').textContent = 'Achar uma peça';
      $('cmpTitle').textContent = `Peça nº ${n}`;
      $('cmpSub').textContent = `Coluna ${cell.col + 1} · Linha ${cell.row + 1} · ${c.items.length} candidatas nas fotos`;
      $('cmpYesText').textContent = 'É essa! Encaixei';
      $('cmpPieceCap').textContent = `foto ${item.photo + 1}`;
    } else {
      $('cmpKicker').textContent = 'Onde vai esta peça';
      $('cmpTitle').textContent = `Vai na nº ${n}?`;
      $('cmpSub').textContent = `Coluna ${cell.col + 1} · Linha ${cell.row + 1} · ${zone}`;
      $('cmpYesText').textContent = 'É aqui! Encaixei';
      $('cmpPieceCap').textContent = `foto ${c.piece.photo + 1}`;
    }
    $('cmpArtCap').textContent = `nº ${n}`;
    drawArt(cell);

    const piece = $('cmpPiece');
    piece.src = `data:image/jpeg;base64,${c.kind === 'find' ? item.thumb_base64 : c.piece.thumb_base64}`;
    piece.style.transform = `rotate(${item.rotation_deg}deg)`;
    $('cmpRotation').textContent = rotationLabel(item.rotation_deg);

    const badge = $('cmpBadge');
    badge.className = `chip ${conf === 'sure' ? 'chip-sure' : conf === 'maybe' ? 'chip-maybe' : 'chip-low'}`;
    badge.textContent = conf === 'sure' ? 'Muito provável' : conf === 'maybe' ? 'Possível' : 'Pouco provável';

    const notes = [];
    if (c.kind === 'find' && c.index === 0) {
      const h = holeLabel(c.hole);
      if (h) notes.push(h);
    }
    if (item.shape_ok === false) notes.push('As abas e encaixes desta peça não batem com o buraco.');
    if (item.edge_ok === false) notes.push('Os lados retos desta peça não batem com a posição na borda.');
    $('cmpNote').textContent = notes.join(' ');
    $('cmpNote').classList.toggle('hidden', !notes.length);
    $('cmpNote').classList.toggle('text-amber-300', item.shape_ok === false || item.edge_ok === false);
    $('cmpNote').classList.toggle('text-slate-400', !(item.shape_ok === false || item.edge_ok === false));

    $('cmpPager').textContent = `${c.index + 1} de ${c.items.length}`;
    $('cmpPrev').disabled = c.index === 0;
    $('cmpNext').disabled = c.index >= c.items.length - 1;
    const photoNo = (c.kind === 'find' ? item.photo : c.piece.photo) + 1;
    $('cmpPhotoSummary').textContent = tablePhotos.length > 1 ? `Está na foto ${photoNo}: ver onde` : 'Ver onde ela está na foto';
    const wrap = $('cmpPhotoWrap');
    if (wrap.open) drawPhoto();
  }

  // Arte da caixa em volta da célula (±0,75 célula), com a célula contornada
  function drawArt(cell) {
    const p = currentPuzzle;
    const art = grid.art;
    const cw = art.width / p.cols, ch = art.height / p.rows;
    const pad = 0.75;
    const sx = (cell.col - pad) * cw, sy = (cell.row - pad) * ch, sw = (1 + 2 * pad) * cw, sh = (1 + 2 * pad) * ch;
    const canvas = $('cmpArt');
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const k = size / Math.max(sw, sh);
    const ox = (size - sw * k) / 2, oy = (size - sh * k) / 2;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(art, sx, sy, sw, sh, ox, oy, sw * k, sh * k);
    const rx = ox + pad * cw * k, ry = oy + pad * ch * k;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)';
    ctx.strokeRect(rx, ry, cw * k, ch * k);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(rx, ry, cw * k, ch * k);
  }

  // Foto das peças com a candidata circulada: inteira (para saber em qual folha está) ou de perto
  async function drawPhoto() {
    const c = state.cmp;
    if (!c) return;
    const item = c.items[c.index];
    const photoIdx = c.kind === 'find' ? item.photo : c.piece.photo;
    const bbox = c.kind === 'find' ? item.bbox : c.piece.bbox;
    const photo = tablePhotos[photoIdx];
    const canvas = $('cmpPhoto');
    if (!photo || !bbox) return;
    let bmp = state.bitmaps.get(photo.url);
    if (!bmp) {
      bmp = await createImageBitmap(photo.blob);
      state.bitmaps.set(photo.url, bmp);
    }
    if (state.cmp !== c) return;
    const [x, y, w, h] = bbox;
    const cx = x + w / 2, cy = y + h / 2;
    let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
    if (state.photoZoom) {
      const m = Math.max(w, h) * 1.6;
      sx = Math.max(0, cx - m);
      sy = Math.max(0, cy - m * 0.6);
      sw = Math.min(bmp.width - sx, 2 * m);
      sh = Math.min(bmp.height - sy, 1.2 * m);
    }
    canvas.width = 720;
    canvas.height = Math.round((720 * sh) / sw);
    const ctx = canvas.getContext('2d');
    const k = canvas.width / sw;
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    // Círculo com contorno escuro: aparece em folha branca e em mesa escura; nunca menor que um dedo
    const r = Math.max(Math.max(w, h) * 0.75 * k, 22);
    const px = (cx - sx) * k, py = (cy - sy) * k;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.8)';
    ctx.stroke();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#34d399';
    ctx.stroke();
    // Número da foto (= número da folha) em destaque
    const label = `Foto ${photoIdx + 1}`;
    ctx.font = 'bold 34px system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(2, 6, 23, 0.78)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(12, 12, tw + 28, 50, 12); else ctx.rect(12, 12, tw + 28, 50);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 26, 38);
    $('cmpPhotoCap').textContent = state.photoZoom ? `De perto, na foto ${photoIdx + 1}` : `Foto ${photoIdx + 1} inteira: a peça está no círculo verde`;
    const zb = $('cmpPhotoZoom');
    zb.textContent = state.photoZoom ? 'Ver a foto inteira' : 'Aproximar';
    zb.setAttribute('aria-pressed', String(state.photoZoom));
  }

  $('cmpPhotoZoom').addEventListener('click', () => {
    state.photoZoom = !state.photoZoom;
    drawPhoto();
  });
  $('cmpPhotoWrap').addEventListener('toggle', () => { if ($('cmpPhotoWrap').open) drawPhoto(); });
  $('cmpClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => {
    state.cmp = null;
    renderMarks();
  });
  $('cmpPrev').addEventListener('click', () => { state.cmp.index--; renderCompare(); });
  $('cmpNext').addEventListener('click', () => { state.cmp.index++; renderCompare(); });

  $('cmpNo').addEventListener('click', () => {
    const c = state.cmp;
    const item = c.items[c.index];
    if (c.kind === 'locate') state.rejected.add(`${c.piece.id}:${item.col},${item.row}`);
    if (c.index < c.items.length - 1) {
      c.index++;
      renderCompare();
      renderMarks();
      return;
    }
    dlg.close();
    notify(c.kind === 'find'
      ? 'Nenhuma das candidatas. Tente outra foto das peças ou a câmera ao vivo.'
      : 'Nenhuma das células sugeridas. Esta peça foi para "Sem lugar claro".', 'info', 6000);
    renderLocate();
  });

  $('cmpYes').addEventListener('click', async () => {
    const c = state.cmp;
    const item = c.items[c.index];
    const cell = cmpCell();
    const btn = $('cmpYes');
    if (!currentPuzzle || !supabaseClient) return;
    btn.disabled = true;
    try {
      await registerFound({ cell, rotation: item.rotation_deg });
      calibAdd(c.kind === 'find' ? item.sig : c.piece.sig, cell, item.rotation_deg);
      if (c.kind === 'locate') state.placedPieces.add(c.piece.id);
      dlg.close();
      notify(`Peça nº ${Grid.cellNumber(cell.col, cell.row, currentPuzzle.cols)} encaixada.`, 'success');
      renderLocate();
      renderMarks();
    } catch (err) {
      notify(`Erro ao registrar peça: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  setMode('find');
  return { onGridMode, refresh, onScanned, onPhotosChanged, onMapTap, openFindResults, calibPayload, get mode() { return state.mode; } };
})();
