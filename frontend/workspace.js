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
    assign: new Map(),    // id da peça → candidata que ficou com ela (cada célula aceita uma peça só)
    review: null,         // conferência em sequência das "certas": { queue: [ids] }
    locateParts: [],      // lotes do "onde vai cada peça" já prontos (continua de onde parou)
    locateKey: null,      // a que fotos e mapa esses lotes pertencem
    persistOff: true,     // não salva enquanto troca de quebra-cabeça ou restaura a sessão
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
    state.assign = new Map();
    state.review = null;
    state.locateParts = [];
    state.locateKey = null;
    state.persistOff = true;
    renderLocate();
    setMode('find');
    refresh({ autoOpen: true });
    if (on) restoreSession();
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
    if (autoOpen) {
      openStep(firstTodo);
      // Entrou no mapa (ou escaneou): refaz o que depende do mapa montado, como a sessão restaurada
      if (state.located) { refreshAssign(); renderLocate(); renderMarks(); }
    }
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

  // Outro participante mudou o mapa: refaz a atribuição e as marcas
  function remoteChanged() {
    refreshAssign();
    renderLocate();
    renderMarks();
  }

  function onPhotosChanged() {
    refresh();
    if (state.located) {
      // Foto removida: as peças dela saem do resultado
      const ids = new Set(tablePhotos.map((p) => p.id));
      const before = state.located.pieces.length;
      state.located.pieces = state.located.pieces.filter((pc) => ids.has(pc.photoId));
      state.located.pieces.forEach((pc) => { pc.photo = tablePhotos.findIndex((p) => p.id === pc.photoId); });
      if (!tablePhotos.length) state.located = null;
      if (state.located && state.located.pieces.length !== before) { refreshAssign(); renderLocate(); renderMarks(); }
      if (!state.located) { refreshAssign(); renderLocate(); renderMarks(); }
    }
    if (state.located && state.locatedFor !== photosSignature()) {
      $('locateIntro').textContent = 'As fotos mudaram. Localize de novo para incluir as peças novas.';
    }
    persist();
    scheduleCount();
  }

  // Fotos que já foram localizadas (as concluídas ficam de fora)
  const photosSignature = () => tablePhotos.filter((p) => !p.done).map((p) => p.id).join('|');

  // ---------- Abas ----------
  const tabs = { find: $('tabFind'), locate: $('tabLocate') };

  function setMode(mode) {
    state.mode = mode;
    for (const [m, tab] of Object.entries(tabs)) {
      const on = m === mode;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    $('fullTabFind').setAttribute('aria-selected', String(mode === 'find'));
    $('fullTabLocate').setAttribute('aria-selected', String(mode === 'locate'));
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
  $('fullTabFind').addEventListener('click', () => setMode('find'));
  $('fullTabLocate').addEventListener('click', () => setMode('locate'));
  $('tabFind').parentElement.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = state.mode === 'find' ? 'locate' : 'find';
    setMode(next);
    tabs[next].focus();
  });

  // ---------- Peças → mapa ----------
  $('btnLocate').addEventListener('click', locate);

  async function locate() {
    const photos = tablePhotos.filter((p) => !p.done); // foto concluída fica de fora
    if (!photos.length || !grid.art) {
      if (tablePhotos.length && !photos.length) notify('Todas as fotos estão concluídas.', 'info');
      return;
    }
    const p = currentPuzzle;
    const btn = $('btnLocate');
    btn.disabled = true;
    show($('locateLoading'), 'flex');
    $('locateLoadingText').textContent = serviceStatus.api === 'ok'
      ? `Separando as peças de ${photos.length === 1 ? '1 foto' : `${photos.length} fotos`} e comparando com a caixa…`
      : 'Acordando o servidor… a primeira busca do dia pode levar até 1 minuto.';
    // Lotes já prontos valem enquanto as fotos e o mapa forem os mesmos: se a internet cair, continua de onde parou
    const key = `${grid.scanMap || ''}|${photos.map((x) => x.id).join(',')}`;
    if (state.locateKey !== key) { state.locateParts = []; state.locateKey = key; }
    const parts = state.locateParts;
    const calib = calibPayload();
    const buildForm = (chunk) => {
      const form = new FormData();
      Search.appendPhotos(form, chunk);
      Search.appendArt(form);
      form.append('cols', p.cols);
      form.append('rows', p.rows);
      form.append('top_k', '5');
      if (grid.scanMap) form.append('scan_map', grid.scanMap);
      if (calib.length) form.append('calib', JSON.stringify(calib));
      if (p.width_cm > 0) form.append('piece_mm', String((p.width_cm * 10) / p.cols));
      return form;
    };
    try {
      if (apiWakeup) await apiWakeup;
      await Search.run('/api/locate-pieces', photos, buildForm, {
        parts, timeoutMs: 240000,
        errorText: 'Não foi possível localizar as peças.',
        onPart: () => persist(),
        onBatch: ({ from, to, total }) => {
          if (total > PHOTOS_PER_REQUEST) $('locateLoadingText').textContent = `Separando as peças das fotos ${from + 1}–${to} de ${total} e comparando com a caixa…`;
        },
      });
      state.located = Search.mergeLocate(parts);
      state.locatedFor = photosSignature();
      state.locateParts = [];
      state.locateKey = null;
      state.rejected.clear();
      state.placedPieces.clear();
      // Peça já confirmada que continua nas fotos: mesma assinatura → já está encaixada
      const confirmedSigs = new Set(calibLoad().map((c) => c.sig));
      for (const photo of tablePhotos) photo.confirmed.forEach((sig) => confirmedSigs.add(sig));
      for (const piece of state.located.pieces) if (piece.sig && confirmedSigs.has(piece.sig)) state.placedPieces.add(piece.id);
      refreshAssign();
      setServiceStatus('api', 'ok', 'Online');
      $('locateIntro').textContent = 'Toque numa peça (ou numa marca do mapa) para comparar com a caixa e confirmar.';
      renderLocate();
      renderMarks();
      persist();
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    } catch (err) {
      const done = parts.filter((x) => x.data).reduce((n, x) => n + x.photos.length, 0);
      const resume = done ? ` As ${done} fotos já analisadas ficaram salvas: toque em "Localizar" para continuar de onde parou.` : '';
      notify((err.name === 'AbortError' ? 'O servidor demorou demais.' : err.message) + resume, 'error', 9000);
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

  // Cada célula aceita uma peça só. Em ordem de diferença de cor (a menor primeiro), cada peça fica com a melhor
  // célula que ninguém levou. Nas fotos reais isso sobe o 1º lugar de 45% para 49% e, quando há quase uma peça para
  // cada célula que falta, de 68% para 83%. Refeito a cada confirmação ou recusa.
  function refreshAssign() {
    state.assign = new Map();
    if (!state.located || !currentPuzzle) return;
    const triples = [];
    for (const piece of state.located.pieces) {
      if (state.placedPieces.has(piece.id)) continue;
      for (const c of liveCandidates(piece)) triples.push([c.distance == null ? 1e9 : c.distance, piece, c]);
    }
    triples.sort((a, b) => a[0] - b[0]);
    const taken = new Set();
    for (const [, piece, c] of triples) {
      const cell = c.row * currentPuzzle.cols + c.col;
      if (state.assign.has(piece.id) || taken.has(cell)) continue;
      state.assign.set(piece.id, c);
      taken.add(cell);
    }
  }

  // Onde a peça vai e com que confiança. "Vai aqui" (verde) só quando a célula é a 1ª da peça, a nota é alta
  // e nenhuma outra peça melhor disputa a mesma célula (precisão nas fotos reais: 90–99%, antes 85–96%)
  function placeOf(piece) {
    const top = liveCandidates(piece)[0];
    if (!top) return { cand: null, conf: 'low' };
    const a = state.assign.get(piece.id);
    if (a === top) {
      const sure = piece.confident && top === piece.candidates[0];
      return { cand: top, conf: sure ? 'sure' : top.score >= MAYBE ? 'maybe' : 'low' };
    }
    // A 1ª célula ficou com outra peça mais parecida: mostra a que sobrou, só como "talvez"
    if (a) return { cand: a, conf: a.score >= 40 ? 'maybe' : 'low', disputed: true };
    return { cand: top, conf: 'low', disputed: true };
  }

  // Confiança de uma candidata específica (na tela de comparar, onde dá para olhar as 5)
  function confOf(piece, cand) {
    const place = placeOf(piece);
    if (cand === place.cand) return place.conf;
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
    $('btnBank').classList.toggle('hidden', !(data && data.pieces.length));
    if (!data) { hide(summary, 'flex'); $('btnReviewSure').classList.add('hidden'); $('locateHint').classList.add('hidden'); return; }

    // Grupos: bordas (lados retos) primeiro, depois as regiões do mapa, e as sem lugar claro por último
    const groups = new Map();
    const add = (key, title, zone, piece, cand, conf) => {
      if (!groups.has(key)) groups.set(key, { title, zone, items: [] });
      groups.get(key).items.push({ piece, cand, conf });
    };
    let sure = 0, maybe = 0, low = 0, done = 0;
    for (const piece of data.pieces) {
      if (state.placedPieces.has(piece.id)) { done++; continue; }
      const { cand, conf } = placeOf(piece);
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
    $('locateHint').classList.toggle('hidden', !(sure + maybe));
    const reviewBtn = $('btnReviewSure');
    reviewBtn.classList.toggle('hidden', !sure);
    $('btnReviewSureText').textContent = `Conferir as ${sure} ${sure === 1 ? 'certa' : 'certas'} em sequência`;

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
      const { cand, conf } = placeOf(piece);
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
      const { cand, conf } = placeOf(piece);
      if (!cand || conf === 'low') continue;
      const d = Math.max(Math.abs(cand.col - col), Math.abs(cand.row - row));
      if (d > 1) continue;
      if (!best || d < best.d || (d === best.d && cand.score > best.cand.score)) best = { piece, cand, d };
    }
    if (best) openLocate(best.piece);
    else notify(`Nenhuma peça das fotos aponta para a nº ${Grid.cellNumber(col, row, currentPuzzle.cols)}.`, 'info');
    return true;
  }

  // ---------- Contagem das peças achadas em cada foto ----------
  // Ao anexar, o servidor separa as peças de cada foto e o app mostra quantas achou; o usuário confere com as que ele
  // pôs na folha (um número a menos é peça que nunca será encontrada; um a mais, sombra ou resto de papel).
  let countTimer = null;
  const counting = { on: false, again: false };

  function scheduleCount() {
    clearTimeout(countTimer);
    if (!currentPuzzle || !isGridPuzzle(currentPuzzle)) { renderCountRow(); return; }
    countTimer = setTimeout(countMissing, 500);
    renderCountRow();
  }

  async function countMissing() {
    const todo = tablePhotos.filter((p) => !p.counted);
    if (!todo.length) { renderCountRow(); return; }
    if (counting.on) { counting.again = true; return; }
    counting.on = true;
    renderCountRow();
    const puzzle = currentPuzzle;
    try {
      if (apiWakeup) await apiWakeup;
      await Search.count(todo, {
        pieceMm: puzzle.width_cm > 0 ? (puzzle.width_cm * 10) / puzzle.cols : null,
        onBatch: () => renderCountRow(),
        onPart: () => { renderTablePhotos(); renderCountRow(); persist(); },
      });
    } catch (err) {
      // Sem conexão ou servidor dormindo: a contagem tenta de novo quando o usuário abrir "Conferir contagem"
      counting.error = err.message;
    } finally {
      counting.on = false;
      renderCountRow();
      if (counting.again || tablePhotos.some((p) => !p.counted && !counting.error)) { counting.again = false; scheduleCount(); }
    }
  }

  function countSummary() {
    const counted = tablePhotos.filter((p) => p.counted);
    const total = counted.reduce((n, p) => n + Search.expected(p), 0);
    const confirmed = counted.filter((p) => p.countOk).length;
    return { counted, total, confirmed };
  }

  function renderCountRow() {
    const row = $('countRow');
    if (!tablePhotos.length || !currentPuzzle || !isGridPuzzle(currentPuzzle)) { row.classList.add('hidden'); row.classList.remove('flex'); return; }
    const { counted, total, confirmed } = countSummary();
    const pending = tablePhotos.length - counted.length;
    let text;
    if (counting.on) text = `Contando as peças${counted.length ? `: ${total} em ${counted.length} ${counted.length === 1 ? 'foto' : 'fotos'} até agora` : ''}…`;
    else if (!counted.length) text = counting.error ? 'Não consegui contar as peças agora. Toque em "Conferir contagem" para tentar de novo.' : 'Contando as peças…';
    else {
      text = `${total} ${total === 1 ? 'peça achada' : 'peças achadas'} em ${counted.length} ${counted.length === 1 ? 'foto' : 'fotos'}`;
      text += confirmed === counted.length ? ' · todas conferidas ✓' : ` · ${confirmed} de ${counted.length} conferidas`;
      if (pending) text += ` · ${pending} sem contar`;
    }
    $('countText').textContent = text;
    row.classList.remove('hidden');
    row.classList.add('flex');
    $('btnCountOpen').textContent = counted.length && confirmed < counted.length ? 'Conferir contagem' : 'Rever contagem';
  }

  // ----- Diálogo: a foto com cada peça marcada -----
  const cdlg = $('countDialog');
  const cstate = { i: 0, zoom: false, bitmap: null, bitmapFor: null };

  function medianArea(photo) {
    const a = photo.boxes.map((b) => b.area).filter(Boolean).sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : 0;
  }

  // Peças que fogem do tamanho normal: grandes costumam ser duas coladas; pequenas, sombra, resto de papel ou peça cortada
  function suspects(photo) {
    const med = medianArea(photo);
    const out = { big: [], small: [], extra: 0 };
    photo.boxes.forEach((b, i) => {
      if (!med || !b.area) return;
      if (b.area > 1.6 * med) { out.big.push(i); out.extra += Math.max(1, Math.round(b.area / med) - 1); }
      else if (b.area < 0.45 * med) out.small.push(i);
    });
    return out;
  }

  async function openCount(i = 0) {
    const counted = tablePhotos.filter((p) => p.counted);
    if (!counted.length) {
      // Ainda sem contagem: conta agora (com a conexão como estiver) e abre quando terminar
      counting.error = null;
      notify('Contando as peças das fotos…', 'info', 2500);
      await countMissing();
      if (!tablePhotos.some((p) => p.counted)) { notify(counting.error || 'Não consegui contar as peças.', 'error', 6000); return; }
    }
    cstate.i = Math.min(i, tablePhotos.length - 1);
    cstate.zoom = false;
    if (!cdlg.open) cdlg.showModal();
    renderCount();
  }

  async function renderCount() {
    const photo = tablePhotos[cstate.i];
    if (!photo) return;
    const n = tablePhotos.length;
    const { confirmed, counted } = countSummary();
    $('countKicker').textContent = `Foto ${cstate.i + 1} de ${n} · ${confirmed} de ${counted.length} conferidas`;
    $('countPager').textContent = `${cstate.i + 1} de ${n}`;
    $('countPrev').disabled = cstate.i === 0;
    $('countNext').disabled = cstate.i >= n - 1;
    $('countZoom').textContent = cstate.zoom ? 'Ver inteira' : 'Aproximar';
    $('countZoom').setAttribute('aria-pressed', String(cstate.zoom));
    $('countCanvas').style.width = cstate.zoom ? '220%' : '100%';
    if (!photo.counted) {
      $('countTitle').textContent = 'Contando…';
      $('countSub').textContent = 'O servidor ainda não separou as peças desta foto.';
      $('countOk').textContent = 'Aguarde';
      $('countOk').disabled = true;
      $('countSuspect').classList.add('hidden');
      $('countDiff').textContent = '';
      $('countLegend').textContent = '';
      scheduleCount();
      return;
    }
    const found = photo.pieceCount;
    const sus = suspects(photo);
    $('countTitle').textContent = `${found} ${found === 1 ? 'peça achada' : 'peças achadas'}`;
    $('countSub').textContent = photo.countOk
      ? `Conferida: ${Search.expected(photo)} ${Search.expected(photo) === 1 ? 'peça' : 'peças'} nesta folha.`
      : 'Confira se bate com as peças que você pôs nesta folha.';
    $('countLegend').textContent = 'Cada peça achada tem um número. Verde: normal. Âmbar: maior que o normal (pode ser duas coladas) ou muito pequena.';
    const notes = [];
    if (sus.big.length) notes.push(`${sus.big.length} ${sus.big.length === 1 ? 'peça maior' : 'peças maiores'} que o normal (nº ${sus.big.slice(0, 6).map((k) => k + 1).join(', ')}${sus.big.length > 6 ? '…' : ''}): podem ser peças encostadas contadas como uma só. Contando assim, seriam ~${found + sus.extra}.`);
    if (sus.small.length) notes.push(`${sus.small.length} ${sus.small.length === 1 ? 'marca muito pequena' : 'marcas muito pequenas'} (nº ${sus.small.slice(0, 6).map((k) => k + 1).join(', ')}${sus.small.length > 6 ? '…' : ''}): confira se é peça, sombra ou resto de papel.`);
    const box = $('countSuspect');
    box.classList.toggle('hidden', !notes.length);
    box.innerHTML = '';
    notes.forEach((t) => { const p = document.createElement('p'); p.textContent = t; box.appendChild(p); });
    const input = $('countInput');
    input.value = photo.userCount != null ? String(photo.userCount) : '';
    updateDiff();
    await drawCount(photo, sus);
  }

  function updateDiff() {
    const photo = tablePhotos[cstate.i];
    if (!photo || !photo.counted) return;
    const v = $('countInput').value.trim();
    const found = photo.pieceCount;
    const diff = $('countDiff');
    const ok = $('countOk');
    ok.disabled = false;
    if (v === '') {
      diff.textContent = '';
      ok.textContent = `Está certo: ${found} ${found === 1 ? 'peça' : 'peças'}`;
      return;
    }
    const mine = parseInt(v, 10);
    if (!(mine >= 0)) { diff.textContent = ''; ok.disabled = true; ok.textContent = 'Digite um número'; return; }
    if (mine === found) {
      diff.textContent = 'Bate com o que o app achou. ✓';
      diff.className = 'flex-1 text-sm text-emerald-300 leading-snug';
      ok.textContent = `Está certo: ${found} ${found === 1 ? 'peça' : 'peças'}`;
    } else if (mine > found) {
      const d = mine - found;
      diff.textContent = `Faltam ${d} no app: ${d === 1 ? 'uma peça não foi separada' : `${d} peças não foram separadas`} (encostadas em outra, na borda da foto ou escondidas). Afaste-as e fotografe de novo.`;
      diff.className = 'flex-1 text-sm text-amber-300 leading-snug';
      ok.textContent = `Usar ${mine} (a contagem do app tem ${d} a menos)`;
    } else {
      const d = found - mine;
      diff.textContent = `O app achou ${d} a mais: ${d === 1 ? 'pode ser uma sombra ou resto de papel' : 'podem ser sombras ou restos de papel'}. Veja as marcas âmbar.`;
      diff.className = 'flex-1 text-sm text-amber-300 leading-snug';
      ok.textContent = `Usar ${mine} (o app contou ${d} a mais)`;
    }
  }

  async function drawCount(photo, sus) {
    const canvas = $('countCanvas');
    let bmp = cstate.bitmapFor === photo.id ? cstate.bitmap : null;
    if (!bmp) {
      bmp = await createImageBitmap(photo.blob);
      cstate.bitmap = bmp;
      cstate.bitmapFor = photo.id;
    }
    if (tablePhotos[cstate.i] !== photo) return;
    const W = Math.min(1200, bmp.width);
    const k = W / bmp.width;
    canvas.width = W;
    canvas.height = Math.round(bmp.height * k);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    // As caixas vêm no quadro da foto que o servidor decodificou; o tamanho dele pode diferir um pouco do arquivo
    const fx = photo.frame ? bmp.width / photo.frame[0] : 1;
    const fy = photo.frame ? bmp.height / photo.frame[1] : 1;
    const amber = new Set([...sus.big, ...sus.small]);
    ctx.font = `bold ${Math.max(11, Math.round(W / 70))}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    photo.boxes.forEach((b, i) => {
      const [x, y, w, h] = b.bbox;
      const rx = x * fx * k, ry = y * fy * k, rw = w * fx * k, rh = h * fy * k;
      const col = amber.has(i) ? '#fbbf24' : '#34d399';
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)';
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = col;
      ctx.strokeRect(rx, ry, rw, rh);
      const label = String(i + 1);
      const tw = ctx.measureText(label).width + 8;
      const th = Math.round(W / 55);
      ctx.fillStyle = 'rgba(2, 6, 23, 0.8)';
      ctx.fillRect(rx + rw / 2 - tw / 2, ry + rh / 2 - th / 2, tw, th);
      ctx.fillStyle = col;
      ctx.fillText(label, rx + rw / 2, ry + rh / 2 + 1);
    });
  }

  function confirmCount() {
    const photo = tablePhotos[cstate.i];
    if (!photo || !photo.counted) return;
    const v = $('countInput').value.trim();
    photo.userCount = v === '' ? photo.pieceCount : Math.max(0, parseInt(v, 10) || 0);
    photo.countOk = true;
    Learn.log('count', 'hit', { auto: photo.pieceCount, user: photo.userCount });
    renderTablePhotos();
    renderCountRow();
    persist();
    if (cstate.i < tablePhotos.length - 1) { cstate.i++; cstate.zoom = false; renderCount(); }
    else {
      const { counted, total } = countSummary();
      cdlg.close();
      notify(`Contagem conferida: ${total} ${total === 1 ? 'peça' : 'peças'} em ${counted.length} ${counted.length === 1 ? 'foto' : 'fotos'}.`, 'success', 5000);
    }
  }

  $('btnCountOpen').addEventListener('click', () => openCount(0));
  $('countClose').addEventListener('click', () => cdlg.close());
  $('countPrev').addEventListener('click', () => { cstate.i--; cstate.zoom = false; renderCount(); });
  $('countNext').addEventListener('click', () => { cstate.i++; cstate.zoom = false; renderCount(); });
  $('countZoom').addEventListener('click', () => { cstate.zoom = !cstate.zoom; renderCount(); });
  $('countInput').addEventListener('input', updateDiff);
  $('countOk').addEventListener('click', confirmCount);

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
  function openFindResults(data, cell, extra = {}) {
    if (!data.candidates || !data.candidates.length) {
      notify(extra.remaining ? 'Nenhuma peça parecida nas primeiras fotos. Toque em "Procurar nas outras fotos".' : 'Nenhuma peça parecida nas fotos.', 'info');
      return;
    }
    state.cmp = {
      kind: 'find', mode: extra.mode || 'art', cell, items: data.candidates, index: 0, confident: data.confident, hole: data.hole, photos: data.photos,
      remaining: extra.remaining || 0, more: extra.more || null, rejectedSigs: new Set(), loadingMore: false,
    };
    state.photoZoom = false;
    renderCompare();
    if (!dlg.open) dlg.showModal();
  }

  // A busca parou numa peça "muito provável": continua nas fotos que sobraram, a pedido (ou ao recusar todas)
  async function continueFind() {
    const c = state.cmp;
    if (!c || c.kind !== 'find' || !c.more || c.loadingMore) return false;
    c.loadingMore = true;
    renderCompare();
    try {
      const r = await c.more();
      if (state.cmp !== c) return false;
      c.remaining = r.remaining;
      if (!r.remaining) c.more = null;
      const fresh = (r.data ? r.data.candidates : []).filter((x) => !(x.sig && c.rejectedSigs.has(x.sig)));
      if (fresh.length) {
        c.items = fresh;
        c.index = 0;
        c.confident = r.data.confident;
        c.photos = r.data.photos;
      }
      return fresh.length > 0;
    } catch (err) {
      notify(err.name === 'AbortError' ? 'O servidor demorou demais.' : err.message, 'error', 7000);
      return false;
    } finally {
      if (state.cmp === c) { c.loadingMore = false; renderCompare(); }
    }
  }

  // Peças → mapa: a peça é fixa, as candidatas são células
  function openLocate(piece) {
    if (!piece) return;
    const live = liveCandidates(piece);
    if (!live.length) {
      notify('Todas as células sugeridas para esta peça foram recusadas ou já estão montadas.', 'info');
      return;
    }
    // A candidata que ficou com a peça vem primeiro; as outras seguem na ordem de semelhança
    const { cand } = placeOf(piece);
    const items = cand ? [cand, ...live.filter((c) => c !== cand)] : live;
    state.cmp = { kind: 'locate', piece, items, index: 0 };
    state.photoZoom = false;
    renderCompare();
    renderMarks();
    if (!dlg.open) dlg.showModal();
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
      : confOf(c.piece, item);
    const zone = zoneName(zoneOf(cell.col, cell.row)).toLowerCase();

    if (c.kind === 'find') {
      $('cmpKicker').textContent = c.mode === 'hole' ? 'Foto do buraco' : 'Achar uma peça';
      $('cmpTitle').textContent = `Peça nº ${n}`;
      $('cmpSub').textContent = `Coluna ${cell.col + 1} · Linha ${cell.row + 1} · ${c.items.length} candidatas nas fotos`;
      $('cmpYesText').textContent = 'É essa! Encaixei';
      $('cmpPieceCap').textContent = `foto ${item.photo + 1}`;
    } else {
      $('cmpKicker').textContent = state.review ? `Conferindo as certas · ${state.review.index} de ${state.review.total}` : 'Onde vai esta peça';
      $('cmpTitle').textContent = `Vai na nº ${n}?`;
      $('cmpSub').textContent = `Coluna ${cell.col + 1} · Linha ${cell.row + 1} · ${zone}`;
      $('cmpYesText').textContent = 'É aqui! Encaixei';
      $('cmpPieceCap').textContent = `foto ${c.piece.photo + 1}`;
    }
    // Busca local: no lugar da arte da caixa, a própria foto do buraco com a peça candidata encaixada nele
    const fit = c.kind === 'find' && c.mode === 'hole' && item.fit_base64;
    $('cmpArt').classList.toggle('hidden', Boolean(fit));
    $('cmpFit').classList.toggle('hidden', !fit);
    $('cmpArtLabel').textContent = fit ? 'No buraco' : 'Na caixa';
    $('cmpArtCap').textContent = `nº ${n}`;
    if (fit) $('cmpFit').src = `data:image/jpeg;base64,${item.fit_base64}`; else drawArt(cell);

    const piece = $('cmpPiece');
    piece.src = `data:image/jpeg;base64,${c.kind === 'find' ? item.thumb_base64 : c.piece.thumb_base64}`;
    piece.style.transform = `rotate(${item.rotation_deg}deg)`;
    $('cmpRotation').textContent = rotationLabel(item.rotation_deg);

    const badge = $('cmpBadge');
    badge.className = `chip ${conf === 'sure' ? 'chip-sure' : conf === 'maybe' ? 'chip-maybe' : 'chip-low'}`;
    badge.textContent = conf === 'sure' ? 'Muito provável' : conf === 'maybe' ? 'Possível' : 'Pouco provável';

    const notes = [];
    if (c.kind === 'find' && c.index === 0 && c.mode !== 'hole') {
      const h = holeLabel(c.hole);
      if (h) notes.push(h);
    }
    if (item.shape_ok === false) notes.push('As abas e encaixes desta peça não batem com o buraco.');
    if (item.edge_ok === false) notes.push('Os lados retos desta peça não batem com a posição na borda.');
    $('cmpNote').textContent = notes.join(' ');
    $('cmpNote').classList.toggle('hidden', !notes.length);
    $('cmpNote').classList.toggle('text-amber-300', item.shape_ok === false || item.edge_ok === false);
    $('cmpNote').classList.toggle('text-slate-400', !(item.shape_ok === false || item.edge_ok === false));

    // Busca que parou cedo: oferece continuar nas outras fotos
    const moreRow = $('cmpMoreRow');
    const showMore = c.kind === 'find' && c.remaining > 0 && Boolean(c.more);
    moreRow.classList.toggle('hidden', !showMore);
    moreRow.classList.toggle('flex', showMore);
    if (showMore) {
      $('cmpMoreText').textContent = c.confident
        ? `A busca parou na foto ${item.photo + 1}: a peça é muito provável. Faltam ${c.remaining} ${c.remaining === 1 ? 'foto' : 'fotos'} sem olhar.`
        : `Ainda faltam ${c.remaining} ${c.remaining === 1 ? 'foto' : 'fotos'} sem olhar.`;
      $('cmpMore').disabled = c.loadingMore;
      $('cmpMore').textContent = c.loadingMore ? 'Procurando…' : `Procurar nas outras ${c.remaining}`;
    }
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
    state.review = null;
    renderMarks();
  });
  $('cmpMore').addEventListener('click', continueFind);
  $('cmpPrev').addEventListener('click', () => { state.cmp.index--; renderCompare(); });
  $('cmpNext').addEventListener('click', () => { state.cmp.index++; renderCompare(); });

  // Aprendizado contínuo: o que o app sugeriu (posição e confiança) e o que o usuário decidiu
  function logDecision(c, item, outcome) {
    const mode = c.kind === 'locate' ? 'locate' : c.mode === 'hole' ? 'hole' : 'find';
    const conf = c.kind === 'find' ? (c.index === 0 && c.confident ? 'sure' : item.score >= 70 ? 'maybe' : 'low') : confOf(c.piece, item);
    const cell = cmpCell();
    Learn.log(mode, outcome, { rank: c.index + 1, conf, score: item.score, cell: cell.row * currentPuzzle.cols + cell.col, rotation: item.rotation_deg, shapeOk: item.shape_ok, n: c.items.length });
  }

  $('cmpNo').addEventListener('click', async () => {
    const c = state.cmp;
    const item = c.items[c.index];
    logDecision(c, item, 'miss');
    if (c.kind === 'locate') {
      state.rejected.add(`${c.piece.id}:${item.col},${item.row}`);
      refreshAssign();
      persist();
      // Conferindo as certas: "Não é" tira a peça da fila e passa para a próxima
      if (state.review) {
        renderLocate();
        renderMarks();
        openNextReview();
        return;
      }
    } else if (item.sig) {
      c.rejectedSigs.add(item.sig);
    }
    if (c.index < c.items.length - 1) {
      c.index++;
      renderCompare();
      renderMarks();
      return;
    }
    // Acabaram as candidatas: na busca por buraco, olha as fotos que sobraram antes de desistir
    if (c.kind === 'find' && c.more) {
      if (await continueFind()) return;
    }
    dlg.close();
    notify(c.kind === 'find'
      ? 'Nenhuma das candidatas. Tente outra foto das peças ou a câmera ao vivo.'
      : 'Nenhuma das células sugeridas. Esta peça foi para "Sem lugar claro".', 'info', 6000);
    renderLocate();
    renderMarks();
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
      logDecision(c, item, 'hit');
      const sig = c.kind === 'find' ? item.sig : c.piece.sig;
      // A rotação da busca local é relativa à foto do buraco, não à arte: não serve para calibrar a cor
      if (!(c.kind === 'find' && c.mode === 'hole')) calibAdd(sig, cell, item.rotation_deg);
      // Marca a peça como encaixada no localizador (venha a confirmação de onde vier) e confere se a foto acabou
      let piece = c.kind === 'locate' ? c.piece : null;
      if (!piece && sig && state.located) piece = state.located.pieces.find((pc) => pc.sig === sig) || null;
      if (piece) state.placedPieces.add(piece.id);
      const photoIdx = c.kind === 'find' ? item.photo : c.piece.photo;
      notePlaced(tablePhotos[photoIdx], sig);
      refreshAssign();
      notify(`Peça nº ${Grid.cellNumber(cell.col, cell.row, currentPuzzle.cols)} encaixada.`, 'success');
      renderLocate();
      renderMarks();
      persist();
      if (state.review) openNextReview(); else dlg.close();
    } catch (err) {
      notify(`Erro ao registrar peça: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Foto concluída: todas as peças dela já foram encaixadas ----------
  function notePlaced(photo, sig) {
    if (!photo) return;
    if (sig && !photo.confirmed.includes(sig)) photo.confirmed.push(sig);
    let placedIn = 0, locatedIn = 0;
    if (state.located) {
      for (const pc of state.located.pieces) {
        if (pc.photoId !== photo.id) continue;
        locatedIn++;
        if (state.placedPieces.has(pc.id)) placedIn++;
      }
    }
    const wasDone = photo.done;
    if (Search.updateDone(photo, { placedIn, locatedIn }) && !wasDone) {
      notify(`Foto ${tablePhotos.indexOf(photo) + 1} concluída: todas as peças encaixadas. Ela sai das próximas buscas.`, 'success', 6000);
    }
    renderTablePhotos();
  }

  // ---------- Conferir as certas em sequência ----------
  function sureList() {
    if (!state.located) return [];
    return state.located.pieces
      .filter((pc) => !state.placedPieces.has(pc.id) && placeOf(pc).conf === 'sure')
      .sort((a, b) => placeOf(b).cand.score - placeOf(a).cand.score);
  }

  function startReview() {
    const queue = sureList().map((pc) => pc.id);
    if (!queue.length) { notify('Nenhuma peça "certa" no momento.', 'info'); return; }
    state.review = { queue, total: queue.length, index: 0 };
    openNextReview();
  }

  function openNextReview() {
    const r = state.review;
    while (r && r.queue.length) {
      const id = r.queue.shift();
      const piece = state.located && state.located.pieces.find((pc) => pc.id === id);
      // Peça que já foi encaixada ou deixou de ser "certa" (outra peça ficou com a célula) sai da fila
      if (!piece || state.placedPieces.has(id) || placeOf(piece).conf !== 'sure') { r.total--; continue; }
      r.index++;
      openLocate(piece);
      return true;
    }
    state.review = null;
    if (dlg.open) dlg.close();
    notify('Conferência das certas concluída.', 'success');
    return false;
  }

  $('btnReviewSure').addEventListener('click', startReview);

  // ---------- Sessão salva no aparelho ----------
  function snapshot() {
    if (!currentPuzzle || !isGridPuzzle(currentPuzzle)) return null;
    if (!tablePhotos.length && !state.located) return null; // nada para guardar: apaga o registro
    return {
      v: 1,
      savedAt: Date.now(),
      photos: tablePhotos.map((p) => ({ id: p.id, blob: p.blob, issues: p.issues, confirmed: p.confirmed, pieceCount: p.pieceCount, done: p.done, key: p.key,
        boxes: p.boxes, frame: p.frame, counted: p.counted, userCount: p.userCount, countOk: p.countOk })),
      located: state.located,
      locatedFor: state.locatedFor,
      rejected: [...state.rejected],
      placed: [...state.placedPieces],
      parts: state.locateParts.filter((x) => x.data).map((x) => ({ ids: x.photos.map((p) => p.id), data: x.data })),
      locateKey: state.locateKey,
    };
  }

  function persist() {
    if (state.persistOff || !currentPuzzle) return;
    Session.schedule(currentPuzzle.id, snapshot);
    Collab.touch();
  }

  // Antes de trocar de quebra-cabeça: grava o que estiver esperando e para de salvar até restaurar o próximo
  function leavePuzzle() {
    if (!state.persistOff && currentPuzzle) Session.schedule(currentPuzzle.id, snapshot, 0);
    Session.flush();
    state.persistOff = true;
  }

  async function restoreSession() {
    const puzzle = currentPuzzle;
    if (!puzzle || !isGridPuzzle(puzzle)) return;
    const saved = await Session.load(puzzle.id);
    if (currentPuzzle !== puzzle) return;
    if (saved && Array.isArray(saved.photos) && saved.photos.length) {
      tablePhotos.splice(0).forEach((x) => URL.revokeObjectURL(x.url));
      for (const sp of saved.photos) {
        tablePhotos.push({
          id: sp.id, blob: sp.blob, url: URL.createObjectURL(sp.blob), issues: sp.issues || [],
          confirmed: sp.confirmed || [], pieceCount: sp.pieceCount || 0, done: Boolean(sp.done), key: sp.key || null,
          boxes: sp.boxes || [], frame: sp.frame || null, counted: Boolean(sp.counted), userCount: sp.userCount != null ? sp.userCount : null, countOk: Boolean(sp.countOk),
        });
      }
      state.located = saved.located || null;
      state.locatedFor = saved.locatedFor || null;
      state.rejected = new Set(saved.rejected || []);
      state.placedPieces = new Set(saved.placed || []);
      state.locateKey = saved.locateKey || null;
      state.locateParts = (saved.parts || [])
        .map((x) => ({ photos: x.ids.map((id) => tablePhotos.find((p) => p.id === id)).filter(Boolean), data: x.data }))
        .filter((x) => x.photos.length);
      renderTablePhotos();
      refreshAssign();
      renderLocate();
      renderMarks();
      renderCountRow();
      const n = tablePhotos.length;
      notify(`Sessão anterior recuperada: ${n} ${n === 1 ? 'foto' : 'fotos'}${state.located ? ' e o resultado do "onde vai cada peça"' : ''}.`, 'info', 5000);
    }
    Collab.ready(); // com a sessão deste aparelho de volta, a sincronização pode começar
    state.persistOff = false;
  }

  // ---------- Mapa em tela cheia ----------
  const mapBox = $('mapContainer');
  let fullTimer = null;
  state.mapFull = false;

  function setMapFull(on) {
    state.mapFull = on;
    mapBox.classList.toggle('map-full', on);
    document.body.classList.toggle('map-locked', on);
    $('btnMapFull').setAttribute('aria-pressed', String(on));
    $('btnMapFull').setAttribute('aria-label', on ? 'Sair da tela cheia' : 'Mapa em tela cheia');
    $('iconMapExpand').classList.toggle('hidden', on);
    $('iconMapShrink').classList.toggle('hidden', !on);
    if (on) show($('mapFullBar'), 'flex'); else hide($('mapFullBar'), 'flex');
    clearInterval(fullTimer);
    if (on) { updateFullBar(); fullTimer = setInterval(updateFullBar, 300); }
    // Reencaixa o mapa no novo tamanho depois que o navegador refaz o layout
    requestAnimationFrame(() => requestAnimationFrame(() => mapViewer.reset()));
  }

  // Barra de baixo da tela cheia: o que está selecionado e a ação principal da aba
  function updateFullBar() {
    if (!state.mapFull || !currentPuzzle) return;
    const info = $('mapFullInfo');
    const act = $('btnMapFullAction');
    const n = tablePhotos.filter((p) => !p.done).length;
    if (state.mode === 'find') {
      const searching = $('btnFind').disabled && !$('loading').classList.contains('hidden');
      if (grid.cell) info.textContent = `Peça nº ${Grid.cellNumber(grid.cell.col, grid.cell.row, currentPuzzle.cols)} · coluna ${grid.cell.col + 1} · linha ${grid.cell.row + 1}`;
      else info.textContent = 'Toque numa célula clara do mapa';
      act.textContent = searching ? 'Procurando…' : n ? `Procurar nas ${n} ${n === 1 ? 'foto' : 'fotos'}` : 'Sem fotos';
      act.disabled = searching || !grid.cell || !n;
      act.dataset.action = 'find';
    } else if (!state.located) {
      info.textContent = n ? 'Descubra onde vai cada peça das fotos' : 'Anexe fotos das peças primeiro';
      act.textContent = $('btnLocate').disabled && !$('locateLoading').classList.contains('hidden') ? 'Localizando…' : 'Localizar as peças';
      act.disabled = !n || !grid.art || !$('locateLoading').classList.contains('hidden');
      act.dataset.action = 'locate';
    } else {
      const sure = sureList().length;
      info.textContent = `${sure} ${sure === 1 ? 'vai' : 'vão'} aqui · toque numa marca para comparar`;
      act.textContent = sure ? `Conferir as ${sure} certas` : 'Nenhuma certa agora';
      act.disabled = !sure;
      act.dataset.action = 'review';
    }
  }

  $('btnMapFullAction').addEventListener('click', () => {
    const a = $('btnMapFullAction').dataset.action;
    if (a === 'find') $('btnFind').click();
    else if (a === 'locate') $('btnLocate').click();
    else if (a === 'review') startReview();
  });
  $('btnMapFull').addEventListener('click', () => setMapFull(!state.mapFull));
  document.addEventListener('keydown', (e) => {
    // Esc fecha primeiro a janela de comparar (o navegador cuida disso); só depois a tela cheia
    if (e.key === 'Escape' && state.mapFull && !dlg.open) setMapFull(false);
  });

  setMode('find');
  // Para o banco de peças
  function bankApi() {
    return { pieces: state.located ? state.located.pieces : [], placed: state.placedPieces, placeOf, openLocate };
  }

  return { remoteChanged, bankApi, onGridMode, refresh, onScanned, onPhotosChanged, onMapTap, openFindResults, calibPayload, leavePuzzle, get mode() { return state.mode; } };
})();
