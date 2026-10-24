// ==========================================
// CÂMERA DO CELULAR
// Modelo do celular (detectado pelo EXIF da foto ou informado), dicas de configuração por marca
// e avisos por foto (lente ultra-angular, pouca luz, formato 21:9, flash…).
// O EXIF é lido do arquivo original: a compressão do app (canvas) descarta essas informações.
// ==========================================
const Camera = (() => {
  const KEY = 'pf_camera';

  // ---------- EXIF (JPEG / TIFF) ----------
  const IFD0_TAGS = { 0x010F: 'make', 0x0110: 'model', 0x8769: 'exifPtr' };
  const EXIF_TAGS = {
    0x829A: 'exposure', 0x8827: 'iso', 0x9209: 'flash', 0x920A: 'focal',
    0xA002: 'width', 0xA003: 'height', 0xA404: 'digitalZoom', 0xA405: 'focal35',
  };

  async function readExif(file) {
    try {
      const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
      if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
      let off = 2;
      let exif = null;
      while (off + 10 < v.byteLength) {
        const marker = v.getUint16(off);
        if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
        const len = v.getUint16(off + 2);
        if (marker === 0xFFE1 && !exif && v.getUint32(off + 4) === 0x45786966) exif = parseTiff(v, off + 10);
        // Tamanho real da imagem (SOF): o EXIF guarda o da foto original mesmo depois de recortada
        if (exif && marker >= 0xFFC0 && marker <= 0xFFC3) {
          exif.height = v.getUint16(off + 5);
          exif.width = v.getUint16(off + 7);
          return exif;
        }
        off += 2 + len;
      }
      if (exif) { delete exif.width; delete exif.height; }
      return exif;
    } catch (_) { /* arquivo sem EXIF ou truncado */ }
    return null;
  }

  function parseTiff(v, t) {
    const le = v.getUint16(t) === 0x4949;
    const u16 = (o) => v.getUint16(t + o, le);
    const u32 = (o) => v.getUint32(t + o, le);
    const out = {};
    const value = (type, count, at) => {
      if (type === 2) {
        const p = count <= 4 ? at : u32(at);
        let s = '';
        for (let i = 0; i < count; i++) {
          const ch = v.getUint8(t + p + i);
          if (!ch) break;
          s += String.fromCharCode(ch);
        }
        return s.trim();
      }
      if (type === 3) return u16(at);
      if (type === 4) return u32(at);
      if (type === 5 || type === 10) {
        const p = u32(at);
        const den = u32(p + 4);
        return den ? u32(p) / den : null;
      }
      return null;
    };
    const ifd = (start, tags) => {
      const n = u16(start);
      for (let i = 0; i < n; i++) {
        const e = start + 2 + i * 12;
        const name = tags[u16(e)];
        if (name) out[name] = value(u16(e + 2), u32(e + 4), e + 8);
      }
    };
    ifd(u32(4), IFD0_TAGS);
    if (out.exifPtr) ifd(out.exifPtr, EXIF_TAGS);
    delete out.exifPtr;
    return out;
  }

  // ---------- Perfil do celular ----------
  const BRANDS = {
    samsung: 'Samsung', apple: 'iPhone', xiaomi: 'Xiaomi / Redmi / POCO', motorola: 'Motorola',
    google: 'Google Pixel', other: 'Outro',
  };

  function brandOf(text) {
    const s = (text || '').toLowerCase();
    if (/samsung|galaxy|\bsm-/.test(s)) return 'samsung';
    if (/apple|iphone/.test(s)) return 'apple';
    if (/xiaomi|redmi|poco|\bmi \d/.test(s)) return 'xiaomi';
    if (/motorola|\bmoto\b|moto g|moto e|edge \d|razr/.test(s)) return 'motorola';
    if (/google|pixel/.test(s)) return 'google';
    return 'other';
  }

  // Nome amigável: "samsung" + "Galaxy S24 FE" → "Galaxy S24 FE"; "Apple" + "iPhone 13" → "iPhone 13"
  function niceModel(make, model) {
    const m = (model || '').trim();
    const mk = (make || '').trim();
    if (!m) return mk;
    return mk && !m.toLowerCase().includes(mk.toLowerCase()) && brandOf(m) === 'other' ? `${mk} ${m}` : m;
  }

  function load() {
    try {
      const p = JSON.parse(localStorage.getItem(KEY) || 'null');
      return p && p.model ? p : null;
    } catch (_) { return null; }
  }

  function save(p) {
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) { /* segue sem lembrar */ }
    render();
  }

  function setModel(model, source = 'manual') {
    const m = (model || '').trim();
    if (!m) {
      try { localStorage.removeItem(KEY); } catch (_) {}
      render();
      return;
    }
    save({ model: m, brand: brandOf(m), source });
  }

  // Foto nova com EXIF: se o usuário não escolheu o modelo à mão, adota o da foto
  function learnFrom(exif) {
    if (!exif || !exif.model) return;
    const cur = load();
    if (cur && cur.source === 'manual') return;
    const model = niceModel(exif.make, exif.model);
    if (!cur || cur.model !== model) {
      save({ model, brand: brandOf(`${exif.make} ${exif.model}`), source: 'auto' });
      notify(`Celular detectado pela foto: ${model}. As dicas de câmera foram ajustadas para ele.`, 'info', 5000);
    }
  }

  // Chave do aprendizado de cor: cada câmera reproduz as cores de um jeito
  const modelKey = () => { const p = load(); return p ? p.model.toLowerCase() : null; };

  // ---------- Avisos por foto ----------
  // kind: 'pieces' | 'board' | 'box'
  function check(exif, kind) {
    if (!exif) return [];
    const issues = [];
    if (exif.focal35 && exif.focal35 < 18) {
      issues.push({
        code: 'ultrawide', short: '0,6×',
        text: kind === 'board'
          ? 'Foto com a lente ultra-angular (0,5×/0,6×): ela entorta as bordas e a grade sai torta. Use a lente 1× e fotografe de um pouco mais longe (de pé numa cadeira, por exemplo).'
          : 'Foto com a lente ultra-angular (0,5×/0,6×): ela entorta a imagem e tem menos detalhe. Use a lente 1×.',
      });
    }
    if ((exif.iso && exif.iso >= 800) || (exif.exposure && exif.exposure >= 1 / 30)) {
      const parts = [];
      if (exif.iso) parts.push(`ISO ${exif.iso}`);
      if (exif.exposure) parts.push(exif.exposure >= 1 ? `${exif.exposure.toFixed(1)} s` : `1/${Math.round(1 / exif.exposure)} s`);
      issues.push({
        code: 'dark', short: 'pouca luz',
        text: `Pouca luz (${parts.join(', ')}): a foto sai granulada, com cores lavadas, e pode tremer. Acenda mais luzes ou fotografe de dia, perto de uma janela.`,
      });
    }
    if (exif.flash && (exif.flash & 1)) {
      issues.push({ code: 'flash', short: 'flash', text: 'O flash disparou: ele faz reflexo no verniz das peças e muda as cores. Desligue o flash.' });
    }
    if (exif.digitalZoom && exif.digitalZoom > 1.05) {
      issues.push({ code: 'zoom', short: 'zoom', text: `Zoom digital de ${exif.digitalZoom.toFixed(1)}×: a foto perde detalhe. Chegue mais perto em vez de usar o zoom.` });
    }
    const w = exif.width, h = exif.height;
    if (w && h) {
      const ratio = Math.max(w, h) / Math.min(w, h);
      if (ratio > 1.9) {
        issues.push({ code: 'format', short: '21:9', text: 'Formato de tela cheia (21:9 ou 16:9): a câmera corta a foto e perde até 40% dos pixels. Use o formato 3:4 (ou 4:3).' });
      } else if (Math.min(w, h) < 1500) {
        issues.push({ code: 'lowres', short: 'baixa resolução', text: `Foto pequena (${w}×${h}): use a resolução padrão da câmera (12 MP).` });
      }
    }
    return issues;
  }

  // Mostra os avisos sem repetir o mesmo a cada foto da sessão
  const warned = new Set();
  function warn(issues, label) {
    const fresh = issues.filter((i) => !warned.has(i.code));
    if (!fresh.length) return;
    fresh.forEach((i) => warned.add(i.code));
    notify(`${label}: ${fresh.map((i) => i.text).join(' ')}`, 'info', 9000);
  }

  // ---------- Dicas por marca ----------
  const GENERAL = [
    'Lente 1× (a principal). A 0,5×/0,6× entorta a imagem; o zoom digital perde detalhe.',
    'Formato 3:4 (ou 4:3) e resolução padrão (12 MP). O 21:9 corta a foto; 50/108/200 MP só deixa o envio lento.',
    'Flash desligado e sem "beleza", filtros ou modo retrato.',
    'Desligue o que a câmera "melhora" sozinha (otimizador de cena / IA / HDR automático, quando der): ela muda as cores de cada parte da foto de um jeito diferente.',
    'Toque e segure na folha (ou no quebra-cabeça) para travar foco e exposição antes de fotografar.',
  ];

  const BRAND_TIPS = {
    samsung: [
      'Configurações da câmera (engrenagem): desligue o "Otimizador de cena" e ligue as "Linhas de grade" para alinhar a folha.',
      'Na barra de cima da câmera, escolha 3:4 e 12 MP. Na fileira de lentes, use 1× (não 0,6×).',
      'Para cores iguais em todas as fotos: Mais → Pro, ISO 100–200 e balanço de branco fixo em ~5000 K (luz do dia) ou ~4000 K (lâmpada branca).',
      'Se as peças ficarem pequenas, use 2× (no Galaxy é recorte da lente principal, sem perder detalhe) em vez de chegar perto com a 0,6×.',
    ],
    apple: [
      'Ajustes → Câmera: desligue "Live Photos" se não usa, e em "Estilos Fotográficos" use "Padrão".',
      'Ajustes → Câmera → ligue "Controle de Macro". De perto o iPhone troca sozinho para a lente 0,5×: toque na flor amarela para desligar o macro.',
      'Toque e segure na folha até aparecer "BLOQUEIO AE/AF" para travar foco e exposição.',
      'Ajustes → Câmera → Formatos → "Mais compatível" salva em JPEG e mantém as informações da foto que o app usa.',
    ],
    xiaomi: [
      'Desligue o botão "IA" no topo da câmera e escolha a proporção 4:3.',
      'Configurações da câmera: ligue as "Linhas de grade".',
      'Para cores iguais em todas as fotos: Mais → Pro, ISO 100–200 e balanço de branco fixo (~5000 K).',
    ],
    motorola: [
      'Desligue a câmera inteligente / sugestões de IA nas configurações da câmera, se existir.',
      'Use a proporção 4:3 e ligue a grade (Configurações → Assistente de grade).',
      'Para cores iguais: modo Profissional, ISO baixo e balanço de branco fixo.',
    ],
    google: [
      'Desligue o macro automático ao fotografar as peças de perto: ele troca para a lente ultra-angular.',
      'Use a proporção 4:3 e ligue a grade nas configurações da câmera.',
      'Toque na folha e ajuste a exposição na barra para a folha não estourar de branco.',
    ],
    other: [
      'Procure nas configurações da câmera por "IA", "otimizador de cena" ou "HDR automático" e desligue.',
      'Use a proporção 4:3, ligue a grade e, se houver, o modo Pro com ISO baixo e balanço de branco fixo.',
    ],
  };

  const BY_KIND = {
    pieces: [
      'Peças viradas para cima numa folha branca, sem uma encostar na outra; a folha pode ocupar a foto toda.',
      'Celular de cima e paralelo à folha (a grade ajuda), a uns 30–40 cm.',
      'Luz de dia perto da janela ou luz branca do teto, vinda de lado: sem a sombra do celular sobre as peças e sem reflexo.',
    ],
    board: [
      'Lente 1×, de cima e paralelo ao quebra-cabeça, com os 4 cantos visíveis e um pouco de margem.',
      'Se não couber com a 1×, suba numa cadeira em vez de usar a 0,6×.',
      'Luz espalhada: o reflexo do verniz apaga o desenho e conta como peça faltando.',
    ],
    box: [
      'Caixa de frente, ocupando a foto, sem reflexo do plástico (incline um pouco a caixa em relação à luz).',
      'Melhor ainda: a imagem da arte do site do fabricante.',
    ],
  };

  // ---------- Diálogo "Câmera do celular" ----------
  const $ = (id) => document.getElementById(id);
  const dlg = $('cameraDialog');

  function list(items) {
    const ul = document.createElement('ul');
    ul.className = 'list-disc pl-5 space-y-1.5 text-sm text-slate-300';
    for (const t of items) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    }
    return ul;
  }

  function section(title, items) {
    const sec = document.createElement('section');
    const h = document.createElement('h3');
    h.className = 'font-bold text-[15px] mb-2';
    h.textContent = title;
    sec.append(h, list(items));
    return sec;
  }

  function renderGuide() {
    const p = load();
    const brand = p ? p.brand : 'other';
    const box = $('cameraGuide');
    box.innerHTML = '';
    box.append(
      section(p ? `Configurar uma vez no ${p.model}` : 'Configurar uma vez', [...BRAND_TIPS[brand], ...GENERAL]),
      section('Fotos das peças', BY_KIND.pieces),
      section('Foto do tabuleiro', BY_KIND.board),
      section('Foto da caixa', BY_KIND.box),
    );
  }

  function render() {
    const p = load();
    const label = p ? p.model : 'Configurar a câmera';
    for (const el of document.querySelectorAll('[data-camera-label]')) el.textContent = label;
    if (dlg.open) renderGuide();
    $('cameraModel').value = p ? p.model : '';
    $('cameraSource').textContent = !p ? 'Informe o modelo ou tire uma foto: o app detecta pelo arquivo.'
      : p.source === 'auto' ? `Detectado pela foto (${BRANDS[p.brand]}).` : `Informado por você (${BRANDS[p.brand]}).`;
  }

  function open() {
    render();
    renderGuide();
    dlg.showModal();
  }

  $('cameraForm').addEventListener('submit', (e) => {
    e.preventDefault();
    setModel($('cameraModel').value, 'manual');
    renderGuide();
    notify($('cameraModel').value.trim() ? 'Celular salvo. As dicas foram ajustadas.' : 'Modelo apagado: o app volta a detectar pela foto.', 'success');
  });
  $('cameraModel').addEventListener('input', () => {
    // Prévia das dicas da marca enquanto digita
    const brand = brandOf($('cameraModel').value);
    $('cameraSource').textContent = $('cameraModel').value.trim() ? `Marca: ${BRANDS[brand]}. Toque em Salvar.` : '';
  });
  $('btnCameraClose').addEventListener('click', () => dlg.close());
  for (const b of document.querySelectorAll('[data-open-camera]')) b.addEventListener('click', open);

  render();
  return { readExif, check, warn, learnFrom, modelKey, open, brandOf, niceModel };
})();
