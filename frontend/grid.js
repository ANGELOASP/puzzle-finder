// ==========================================
// MAPA POR GRADE: perspectiva, editor de cantos e desenho do mapa
// ==========================================
// Cantos sempre na ordem: superior esquerdo, superior direito, inferior direito, inferior esquerdo
// (da ARTE, não da foto), em coordenadas normalizadas 0..1 da imagem.

const Grid = (() => {

  // ---------- Homografia (4 pontos) ----------
  function solve(A, b) {
    // Eliminação de Gauss com pivotamento parcial (sistema 8×8)
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]];
      [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }

  // Matriz 3×3 que leva src[i] → dst[i]
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function apply(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  const UNIT = [[0, 0], [1, 0], [1, 1], [0, 1]];

  // ---------- Imagens ----------
  async function loadBitmap(blob, maxSide = 3000) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('Formato de imagem não suportado.'));
        im.src = url;
      });
      const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * s);
      canvas.height = Math.round(img.naturalHeight * s);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function canvasToBlob(canvas, quality = 0.9) {
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Falha ao gerar a imagem.')), 'image/jpeg', quality));
  }

  // Tamanho médio (px) de uma célula na foto, a partir dos cantos marcados
  function nativeCell(source, corners, cols, rows) {
    const pts = corners.map(([x, y]) => [x * source.width, y * source.height]);
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const w = (d(pts[0], pts[1]) + d(pts[3], pts[2])) / 2 / cols;
    const h = (d(pts[0], pts[3]) + d(pts[1], pts[2])) / 2 / rows;
    return { w, h };
  }

  // Proporção altura/largura de uma célula: pelas medidas da caixa, ou estimada pela foto
  function cellAspect(puzzle, source, corners) {
    if (puzzle.width_cm > 0 && puzzle.height_cm > 0) {
      return (puzzle.height_cm / puzzle.rows) / (puzzle.width_cm / puzzle.cols);
    }
    const n = nativeCell(source, corners, puzzle.cols, puzzle.rows);
    return n.h / n.w;
  }

  /**
   * Cantos (normalizados na foto) da janela de células [col − span, col + span] × [row − span, row + span]
   * do quebra-cabeça marcado por `corners`: a mesma perspectiva, só que em volta de uma célula.
   */
  function windowCorners(corners, cols, rows, col, row, span = 1) {
    const H = homography(UNIT, corners);
    const u0 = (col - span) / cols, u1 = (col + 1 + span) / cols;
    const v0 = (row - span) / rows, v1 = (row + 1 + span) / rows;
    return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => apply(H, u, v));
  }

  /**
   * "Endireita" a área marcada: devolve um canvas com exatamente cols × rows células
   * (mais `margin` células de borda em volta, usadas para aprender a cor da mesa).
   */
  function rectify(source, corners, { cols, rows, cellW, cellH, margin = 0 }) {
    const W = Math.round((cols + 2 * margin) * cellW);
    const Hh = Math.round((rows + 2 * margin) * cellH);
    const sw = source.width, sh = source.height;
    const Hm = homography(UNIT, corners.map(([x, y]) => [x * sw, y * sh]));
    const src = source.getContext('2d').getImageData(0, 0, sw, sh).data;
    const out = document.createElement('canvas');
    out.width = W; out.height = Hh;
    const octx = out.getContext('2d');
    const img = octx.createImageData(W, Hh);
    const dst = img.data;
    const mu = margin / cols, mv = margin / rows;
    const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = Hm;
    for (let y = 0; y < Hh; y++) {
      const v = ((y + 0.5) / Hh) * (1 + 2 * mv) - mv;
      for (let x = 0; x < W; x++) {
        const u = ((x + 0.5) / W) * (1 + 2 * mu) - mu;
        const w = h6 * u + h7 * v + h8;
        const sx = (h0 * u + h1 * v + h2) / w - 0.5;
        const sy = (h3 * u + h4 * v + h5) / w - 0.5;
        const o = (y * W + x) * 4;
        if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
          dst[o + 3] = 255; // fora da foto: preto
          continue;
        }
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        for (let c = 0; c < 3; c++) {
          const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
          const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
          dst[o + c] = top + (bot - top) * fy;
        }
        dst[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  // ---------- Número da peça ↔ coluna/linha ----------
  // Numeração: linha por linha, da esquerda para a direita, começando em 1 no canto superior esquerdo
  const cellNumber = (col, row, cols) => row * cols + col + 1;
  const cellFromNumber = (n, cols) => ({ col: (n - 1) % cols, row: Math.floor((n - 1) / cols) });

  // ---------- Mapa: arte + grade + células faltando em vermelho ----------
  function renderMap(art, cols, rows, scanMap) {
    const c = document.createElement('canvas');
    c.width = art.width; c.height = art.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(art, 0, 0);
    const cw = art.width / cols, ch = art.height / rows;
    if (scanMap && scanMap.length === cols * rows) {
      ctx.fillStyle = 'rgba(2, 6, 23, 0.55)';
      for (let i = 0; i < scanMap.length; i++) {
        if (scanMap[i] !== '1') continue; // montadas ficam escurecidas: o que falta salta aos olhos
        ctx.fillRect((i % cols) * cw, Math.floor(i / cols) * ch, cw, ch);
      }
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = Math.max(1, cw / 40);
    ctx.beginPath();
    for (let i = 0; i <= cols; i++) { ctx.moveTo(i * cw, 0); ctx.lineTo(i * cw, c.height); }
    for (let j = 0; j <= rows; j++) { ctx.moveTo(0, j * ch); ctx.lineTo(c.width, j * ch); }
    ctx.stroke();
    return c;
  }

  // ---------- Editor de cantos (tela cheia) ----------
  const dlg = document.getElementById('cornerDialog');
  const stage = document.getElementById('cornerStage');
  const canvas = document.getElementById('cornerCanvas');
  const titleEl = document.getElementById('cornerTitle');
  const hintEl = document.getElementById('cornerHint');
  const btnRotate = document.getElementById('btnCornerRotate');
  const btnOk = document.getElementById('btnCornerOk');
  const btnCancel = document.getElementById('btnCornerCancel');
  const btnSkipMat = document.getElementById('btnCornerSkipMat');

  let ed = null; // estado do editor aberto

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const r = stage.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    // Folga em volta da foto: cantos na beirada continuam inteiros e fáceis de arrastar
    const pad = 28;
    const s = Math.min((r.width - 2 * pad) / ed.img.width, (r.height - 2 * pad) / ed.img.height);
    ed.view = { s, dpr, ox: (r.width - ed.img.width * s) / 2, oy: (r.height - ed.img.height * s) / 2, w: r.width, h: r.height };
    draw();
  }

  const toScreen = ([x, y]) => [ed.view.ox + x * ed.img.width * ed.view.s, ed.view.oy + y * ed.img.height * ed.view.s];
  const toNorm = (sx, sy) => [
    Math.min(1, Math.max(0, (sx - ed.view.ox) / (ed.img.width * ed.view.s))),
    Math.min(1, Math.max(0, (sy - ed.view.oy) / (ed.img.height * ed.view.s))),
  ];

  function draw() {
    const ctx = canvas.getContext('2d');
    const { dpr, w, h } = ed.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(ed.img, ed.view.ox, ed.view.oy, ed.img.width * ed.view.s, ed.img.height * ed.view.s);

    const pts = ed.corners.map(toScreen);
    const Hs = homography(UNIT, pts);
    // Grade: as linhas devem cair sobre as divisões das peças quando os cantos estão certos
    const step = (n) => (n > 60 ? Math.ceil(n / 60) : 1);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.55)';
    ctx.beginPath();
    for (let i = 0; i <= ed.cols; i += step(ed.cols)) {
      const a = apply(Hs, i / ed.cols, 0), b = apply(Hs, i / ed.cols, 1);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    for (let j = 0; j <= ed.rows; j += step(ed.rows)) {
      const a = apply(Hs, 0, j / ed.rows), b = apply(Hs, 1, j / ed.rows);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#34d399';
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();

    // Alças: a nº 1 marca o canto SUPERIOR ESQUERDO da arte
    pts.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x, y, i === ed.active ? 15 : 12, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#fbbf24' : '#34d399';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#020617';
      ctx.stroke();
      ctx.fillStyle = '#020617';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 0.5);
    });

    if (ed.matPoint) {
      const [mx, my] = toScreen(ed.matPoint);
      ctx.beginPath();
      ctx.arc(mx, my, 10, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(56, 189, 248, 0.9)';
      ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
    }

    // Lupa: 3× em volta do canto sendo arrastado, no lado oposto ao dedo
    if (ed.active !== null) {
      const [px, py] = pts[ed.active];
      const R = 62, Z = 3;
      const cx = px < w / 2 ? w - R - 12 : R + 12, cy = R + 12;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = '#000'; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      const sx = (px - ed.view.ox) / ed.view.s, sy = (py - ed.view.oy) / ed.view.s;
      const half = R / (Z * ed.view.s);
      ctx.drawImage(ed.img, sx - half, sy - half, 2 * half, 2 * half, cx - R, cy - R, 2 * R, 2 * R);
      ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(cx - 14, cy); ctx.lineTo(cx + 14, cy); ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy + 14); ctx.stroke();
      ctx.restore();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.lineWidth = 3; ctx.strokeStyle = '#f8fafc'; ctx.stroke();
    }
  }

  function pointer(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!ed) return;
    const [x, y] = pointer(e);
    if (ed.step === 'mat') {
      ed.matPoint = toNorm(x, y);
      draw();
      finish(true);
      return;
    }
    const pts = ed.corners.map(toScreen);
    let best = -1, bd = 48; // toque a até 48 px do canto
    pts.forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } });
    if (best < 0) return;
    ed.active = best;
    ed.grab = [pts[best][0] - x, pts[best][1] - y];
    canvas.setPointerCapture(e.pointerId);
    draw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!ed || ed.active === null) return;
    const [x, y] = pointer(e);
    ed.corners[ed.active] = toNorm(x + ed.grab[0], y + ed.grab[1]);
    draw();
  });

  const release = () => { if (ed && ed.active !== null) { ed.active = null; draw(); } };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // Girar: o canto nº 1 (superior esquerdo da arte) passa para o próximo canto da foto
  btnRotate.addEventListener('click', () => {
    if (!ed) return;
    ed.corners = [ed.corners[3], ed.corners[0], ed.corners[1], ed.corners[2]];
    draw();
  });

  btnOk.addEventListener('click', () => {
    if (!ed) return;
    if (ed.askMat && ed.step !== 'mat') {
      ed.step = 'mat';
      titleEl.textContent = 'Toque numa área vazia';
      hintEl.textContent = 'Toque no fundo (madeira, feltro ou mesa) onde ainda não há peças. Isso ensina ao app como é um espaço vazio.';
      btnRotate.classList.add('hidden');
      btnOk.classList.add('hidden');
      btnSkipMat.classList.remove('hidden');
      return;
    }
    finish(true);
  });
  btnSkipMat.addEventListener('click', () => finish(true));
  btnCancel.addEventListener('click', () => finish(false));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
  window.addEventListener('resize', () => { if (ed) layout(); });

  function finish(ok) {
    if (!ed) return;
    const { resolve, corners, matPoint } = ed;
    ed = null;
    dlg.close();
    resolve(ok ? { corners, matPoint } : null);
  }

  /**
   * Abre o editor. `img` é um canvas (de loadBitmap). Resolve com {corners, matPoint} ou null.
   */
  function editCorners({ img, title, hint, corners, cols, rows, askMat = false }) {
    return new Promise((resolve) => {
      ed = {
        img, cols, rows, askMat, resolve,
        corners: (corners && corners.length === 4) ? corners.map(p => [...p]) : [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
        active: null, grab: [0, 0], step: 'corners', matPoint: null,
      };
      titleEl.textContent = title;
      hintEl.textContent = hint;
      btnRotate.classList.remove('hidden');
      btnOk.classList.remove('hidden');
      btnSkipMat.classList.add('hidden');
      btnOk.textContent = askMat ? 'Próximo' : 'Confirmar';
      dlg.showModal();
      requestAnimationFrame(layout);
    });
  }

  return { homography, apply, loadBitmap, canvasToBlob, nativeCell, cellAspect, rectify, windowCorners, renderMap, cellNumber, cellFromNumber, editCorners };
})();
