// ==========================================
// CÂMERA DO APP COM AS CONFIGURAÇÕES IDEAIS
// A câmera nativa do celular escolhe sozinha lente, zoom, flash e foco. Aqui o app abre a câmera já ajustada:
// lente traseira 1×, resolução máxima do sensor, foco, exposição e balanço de branco automáticos contínuos, sem zoom,
// sem flash. Avisa na hora se o celular está inclinado, a imagem está borrada, escura ou estourada.
// Funciona nas fotos do tabuleiro, das peças e do buraco; sem câmera liberada, cai na câmera nativa.
// ==========================================
const Shot = (() => {
  const $ = (id) => document.getElementById(id);
  const supported = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  let stream = null, track = null, timer = null, resolve = null, tilt = null, orient = null;
  const msgs = { tilt: '', sharp: '', light: '' };

  const GUIDES = {
    hole: 'Centralize o buraco: ele deve ocupar cerca de um terço da foto, com as peças vizinhas em volta. Topo do celular para o topo do quebra-cabeça.',
    board: 'Enquadre o quebra-cabeça inteiro, com as 4 pontas à vista, de cima e sem sombra.',
    pieces: 'Peças espalhadas sobre a folha branca (A4), sem se tocar, de cima e sem sombra do celular.',
  };

  function setChip(el, text, ok) {
    el.textContent = text;
    el.className = `px-2.5 py-1 rounded-full text-xs font-bold ${ok ? 'bg-emerald-400/90 text-slate-950' : 'bg-amber-400/90 text-slate-950'}`;
    el.classList.toggle('hidden', !text);
  }

  // Nitidez (variância do laplaciano) e luz (média) de um quadro reduzido
  function analyze() {
    const v = $('shotVideo');
    if (!v.videoWidth) return;
    const c = analyze.c || (analyze.c = document.createElement('canvas'));
    const W = 240, H = Math.round((240 * v.videoHeight) / v.videoWidth);
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const g = new Float32Array(W * H);
    let sum = 0, hi = 0;
    for (let i = 0; i < W * H; i++) { const y = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; g[i] = y; sum += y; if (y > 245) hi++; }
    let m = 0, m2 = 0, n = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - W] - g[i + W];
      m += l; m2 += l * l; n++;
    }
    const sharp = m2 / n - (m / n) ** 2;
    const mean = sum / (W * H);
    const lightOk = mean >= 70 && mean <= 215 && hi / (W * H) < 0.12;
    setChip($('shotLight'), mean < 70 ? 'Pouca luz' : mean > 215 || hi / (W * H) >= 0.12 ? 'Reflexo / claro demais' : 'Luz boa', lightOk);
    setChip($('shotSharp'), sharp < 25 ? 'Focando… segure firme' : 'Nítida', sharp >= 25);
    // a foto só é boa com luz e foco; o botão continua liberado (a pessoa decide)
    $('shotCapture').classList.toggle('opacity-70', !(lightOk && sharp >= 25));
  }

  function onOrient(e) {
    if (e.beta == null) return;
    const t = Math.hypot(e.beta, e.gamma || 0);
    setChip($('shotTilt'), t < 7 ? 'Nivelado' : `Incline ${Math.round(t)}°: deixe o celular paralelo à mesa`, t < 7);
  }

  async function applyIdeal(t) {
    const caps = (t.getCapabilities && t.getCapabilities()) || {};
    const tries = [];
    if (caps.focusMode && caps.focusMode.includes('continuous')) tries.push({ focusMode: 'continuous' });
    if (caps.exposureMode && caps.exposureMode.includes('continuous')) tries.push({ exposureMode: 'continuous' });
    if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) tries.push({ whiteBalanceMode: 'continuous' });
    if (caps.zoom) tries.push({ zoom: Math.max(caps.zoom.min || 1, 1) });
    if (caps.torch) tries.push({ torch: false });
    if (caps.exposureCompensation) tries.push({ exposureCompensation: 0 });
    for (const c of tries) { try { await t.applyConstraints({ advanced: [c] }); } catch (_) { /* esta câmera não aceita: segue */ } }
  }

  function stop() {
    clearInterval(timer);
    window.removeEventListener('deviceorientation', onOrient);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = track = null;
    $('shotVideo').srcObject = null;
  }

  function finish(result) {
    stop();
    if ($('shotDialog').open) $('shotDialog').close();
    const r = resolve; resolve = null;
    if (r) r(result);
  }

  // Abre a câmera. Devolve { blob } ao capturar, { native: true } se o app não conseguiu abrir a câmera (use a nativa),
  // { gallery: File } se a pessoa escolheu da galeria, ou null se cancelou.
  async function open({ title = 'Tirar foto', guide = 'pieces' } = {}) {
    if (!supported) return { native: true };
    $('shotTitle').textContent = title;
    $('shotHint').textContent = GUIDES[guide] || '';
    $('shotGuide').dataset.guide = guide;
    for (const id of ['shotTilt', 'shotSharp', 'shotLight']) $(id).classList.add('hidden');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 }, frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (_) { return { native: true }; }
    track = stream.getVideoTracks()[0];
    $('shotVideo').srcObject = stream;
    $('shotDialog').showModal();
    try { await $('shotVideo').play(); } catch (_) { /* autoplay */ }
    await applyIdeal(track);
    const st = track.getSettings ? track.getSettings() : {};
    $('shotInfo').textContent = st.width ? `${st.width}×${st.height}` : '';
    window.addEventListener('deviceorientation', onOrient);
    timer = setInterval(analyze, 600);
    return new Promise((res) => { resolve = res; });
  }

  async function capture() {
    if (!track) return;
    const btn = $('shotCapture');
    btn.disabled = true;
    let blob = null;
    try {
      if (window.ImageCapture) {
        const ic = new ImageCapture(track);
        const pc = await ic.getPhotoCapabilities().catch(() => null);
        const opts = { fillLightMode: 'off', redEyeReduction: false };
        if (pc && pc.imageWidth && pc.imageHeight) { opts.imageWidth = pc.imageWidth.max; opts.imageHeight = pc.imageHeight.max; }
        blob = await ic.takePhoto(opts).catch(() => ic.takePhoto());
      }
    } catch (_) { /* usa o quadro do vídeo */ }
    if (!blob) {
      const v = $('shotVideo');
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    }
    btn.disabled = false;
    if (navigator.vibrate) navigator.vibrate(40);
    finish(blob ? { blob } : { native: true });
  }

  $('shotCapture').addEventListener('click', capture);
  $('shotClose').addEventListener('click', () => finish(null));
  $('shotDialog').addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
  $('shotNative').addEventListener('click', () => finish({ native: true }));
  $('shotGalleryInput').addEventListener('change', () => {
    const f = $('shotGalleryInput').files && $('shotGalleryInput').files[0];
    $('shotGalleryInput').value = '';
    if (f) finish({ gallery: f });
  });
  $('shotGallery').addEventListener('click', () => $('shotGalleryInput').click());

  // Faz qualquer <input type=file capture> abrir esta câmera: o arquivo volta pelo mesmo evento "change"
  function bind(input, opts) {
    input.addEventListener('click', async (ev) => {
      if (!supported || input.dataset.native === '1') { input.dataset.native = ''; return; }
      ev.preventDefault();
      const r = await open(opts);
      if (!r) return;
      if (r.native) { input.dataset.native = '1'; input.click(); return; }
      const file = r.gallery || new File([r.blob], `foto-${Date.now()}.jpg`, { type: r.blob.type || 'image/jpeg' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  bind($('holeInput'), { title: 'Foto do buraco', guide: 'hole' });
  bind($('tableInput'), { title: 'Foto das peças', guide: 'pieces' });
  bind($('scanInput'), { title: 'Foto do tabuleiro', guide: 'board' });

  return { open, supported };
})();
