// ==========================================
// 1. REGISTRO DO SERVICE WORKER (PWA)
// ==========================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => console.log('Service Worker registrado:', reg.scope))
      .catch((err) => console.log('Falha no Service Worker:', err));
  });
}

// ==========================================
// 2. LÓGICA DE INSTALAÇÃO DO APP (DESKTOP & MOBILE)
// ==========================================
let deferredPrompt = null;
const btnInstall = document.getElementById('btnInstall');
const installedBadge = document.getElementById('installedBadge');
const iosInstallBanner = document.getElementById('iosInstallBanner');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (btnInstall) {
    btnInstall.classList.remove('hidden');
    btnInstall.classList.add('flex');
  }
});

if (btnInstall) {
  btnInstall.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log('Resultado da instalação:', outcome);
    deferredPrompt = null;
    btnInstall.classList.add('hidden');
    btnInstall.classList.remove('flex');
  });
}

window.addEventListener('appinstalled', () => {
  if (btnInstall) btnInstall.classList.add('hidden');
  if (installedBadge) installedBadge.classList.remove('hidden');
});

const isIos = /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase()) && !window.MSStream;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

if (isIos && !isStandalone && iosInstallBanner) {
  iosInstallBanner.classList.remove('hidden');
}

if (isStandalone && installedBadge) {
  installedBadge.classList.remove('hidden');
}

// ==========================================
// 3. CONFIGURAÇÃO DA API EM NUVEM
// ==========================================
const DEFAULT_API_URL = 'https://puzzle-finder-api.onrender.com';
const apiUrlInput = document.getElementById('apiUrl');
const toggleApiConfig = document.getElementById('toggleApiConfig');
const apiConfigBox = document.getElementById('apiConfigBox');

if (toggleApiConfig && apiConfigBox) {
  toggleApiConfig.addEventListener('click', () => {
    apiConfigBox.classList.toggle('hidden');
  });
}

const savedUrl = localStorage.getItem('puzzle_backend_url');
if (savedUrl && !savedUrl.includes('localhost')) {
  apiUrlInput.value = savedUrl;
} else {
  apiUrlInput.value = DEFAULT_API_URL;
  localStorage.setItem('puzzle_backend_url', DEFAULT_API_URL);
}

apiUrlInput.addEventListener('change', () => {
  localStorage.setItem('puzzle_backend_url', apiUrlInput.value);
});

// ==========================================
// 4. INTEGRAÇÃO COM SUPABASE (BANCO & STORAGE)
// ==========================================
const DEFAULT_SUPABASE_URL = 'https://gfjxcsvxhaojbtuixpjh.supabase.co';
const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmanhjc3Z4aGFvamJ0dWl4cGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyMzU5NjYsImV4cCI6MjEwNjgxMTk2Nn0.gKx3hutXIkemUfVR_O7MFnibpUxY_tYslNSY1D1M4ds';

let supabaseClient = null;
let currentPuzzle = null;
let currentFoundCount = 0;

const btnOpenSupabaseModal = document.getElementById('btnOpenSupabaseModal');
const btnCloseSupabaseModal = document.getElementById('btnCloseSupabaseModal');
const supabaseModal = document.getElementById('supabaseModal');
const supabaseUrlInput = document.getElementById('supabaseUrlInput');
const supabaseKeyInput = document.getElementById('supabaseKeyInput');
const btnSaveSupabaseCreds = document.getElementById('btnSaveSupabaseCreds');
const supabaseStatusLabel = document.getElementById('supabaseStatusLabel');

const puzzleSelect = document.getElementById('puzzleSelect');
const btnNewPuzzle = document.getElementById('btnNewPuzzle');
const newPuzzleModal = document.getElementById('newPuzzleModal');
const btnCloseNewPuzzleModal = document.getElementById('btnCloseNewPuzzleModal');
const btnCreatePuzzleSubmit = document.getElementById('btnCreatePuzzleSubmit');
const newPuzzleName = document.getElementById('newPuzzleName');
const newPuzzleTotal = document.getElementById('newPuzzleTotal');
const newPuzzleBoxFile = document.getElementById('newPuzzleBoxFile');

const puzzleProgressContainer = document.getElementById('puzzleProgressContainer');
const puzzleProgressName = document.getElementById('puzzleProgressName');
const puzzleProgressStats = document.getElementById('puzzleProgressStats');
const puzzleProgressBar = document.getElementById('puzzleProgressBar');
const boxSavedBadge = document.getElementById('boxSavedBadge');
const boxUploadLabel = document.getElementById('boxUploadLabel');
const btnConfirmFound = document.getElementById('btnConfirmFound');

function initSupabase() {
  const url = localStorage.getItem('puzzle_supabase_url') || DEFAULT_SUPABASE_URL;
  const key = localStorage.getItem('puzzle_supabase_key') || DEFAULT_SUPABASE_KEY;

  if (url && key && window.supabase) {
    try {
      supabaseClient = window.supabase.createClient(url, key);
      supabaseStatusLabel.innerText = 'Supabase Conectado 🟢';
      loadPuzzlesFromSupabase();
    } catch (e) {
      console.error('Erro ao conectar ao Supabase:', e);
      supabaseStatusLabel.innerText = 'Erro Supabase ⚠️';
    }
  }
}

btnOpenSupabaseModal.addEventListener('click', () => {
  supabaseUrlInput.value = localStorage.getItem('puzzle_supabase_url') || DEFAULT_SUPABASE_URL;
  supabaseKeyInput.value = localStorage.getItem('puzzle_supabase_key') || DEFAULT_SUPABASE_KEY;
  supabaseModal.classList.remove('hidden');
});

btnCloseSupabaseModal.addEventListener('click', () => {
  supabaseModal.classList.add('hidden');
});

btnSaveSupabaseCreds.addEventListener('click', () => {
  const url = supabaseUrlInput.value.trim();
  const key = supabaseKeyInput.value.trim();

  if (!url || !key) {
    alert('Por favor, informe a URL e a Anon Key do Supabase.');
    return;
  }

  localStorage.setItem('puzzle_supabase_url', url);
  localStorage.setItem('puzzle_supabase_key', key);
  supabaseModal.classList.add('hidden');
  initSupabase();
});

btnNewPuzzle.addEventListener('click', () => {
  newPuzzleModal.classList.remove('hidden');
});

btnCloseNewPuzzleModal.addEventListener('click', () => {
  newPuzzleModal.classList.add('hidden');
});

btnCreatePuzzleSubmit.addEventListener('click', async () => {
  const name = newPuzzleName.value.trim();
  const total = parseInt(newPuzzleTotal.value, 10) || 1000;
  const file = newPuzzleBoxFile.files[0];

  if (!name || !file) {
    alert('Informe o nome do quebra-cabeça e selecione a foto da caixa.');
    return;
  }

  btnCreatePuzzleSubmit.disabled = true;
  btnCreatePuzzleSubmit.innerText = 'Enviando imagem para o Supabase...';

  try {
    const compressedBlob = await compressImage(file);
    const fileName = `box_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;

    const { error: uploadError } = await supabaseClient.storage
      .from('puzzle-images')
      .upload(fileName, compressedBlob, { contentType: 'image/jpeg' });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabaseClient.storage
      .from('puzzle-images')
      .getPublicUrl(fileName);

    const boxImageUrl = publicUrlData.publicUrl;

    const { data: insertData, error: insertError } = await supabaseClient
      .from('puzzles')
      .insert([{ name, total_pieces: total, box_image_url: boxImageUrl }])
      .select()
      .single();

    if (insertError) throw insertError;

    alert('Quebra-cabeça cadastrado com sucesso!');
    newPuzzleModal.classList.add('hidden');
    newPuzzleName.value = '';
    newPuzzleBoxFile.value = '';

    await loadPuzzlesFromSupabase(insertData.id);

  } catch (err) {
    alert(`Erro ao salvar no Supabase: ${err.message}`);
  } finally {
    btnCreatePuzzleSubmit.disabled = false;
    btnCreatePuzzleSubmit.innerText = 'Salvar Quebra-Cabeça no Supabase';
  }
});

async function loadPuzzlesFromSupabase(autoSelectId = null) {
  if (!supabaseClient) return;

  try {
    const { data, error } = await supabaseClient
      .from('puzzles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    puzzleSelect.innerHTML = '<option value="">(Nenhum selecionado - Modo Avulso)</option>';
    data.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.innerText = `${p.name} (${p.total_pieces} peças)`;
      puzzleSelect.appendChild(opt);
    });

    if (autoSelectId) {
      puzzleSelect.value = autoSelectId;
      const found = data.find(p => p.id === autoSelectId);
      if (found) onPuzzleSelected(found);
    }
  } catch (err) {
    console.error('Falha ao carregar puzzles do Supabase:', err);
  }
}

puzzleSelect.addEventListener('change', async (e) => {
  const selectedId = e.target.value;
  if (!selectedId) {
    currentPuzzle = null;
    puzzleProgressContainer.classList.add('hidden');
    boxSavedBadge.classList.add('hidden');
    boxUploadLabel.classList.remove('hidden');
    boxPreview.src = '';
    boxContainer.classList.add('hidden');
    boxBlob = null;
    return;
  }

  const { data } = await supabaseClient.from('puzzles').select('*').eq('id', selectedId).single();
  if (data) onPuzzleSelected(data);
});

async function onPuzzleSelected(puzzle) {
  currentPuzzle = puzzle;
  puzzleProgressContainer.classList.remove('hidden');
  puzzleProgressName.innerText = puzzle.name;

  const { count } = await supabaseClient
    .from('found_pieces')
    .select('*', { count: 'exact', head: true })
    .eq('puzzle_id', puzzle.id);

  currentFoundCount = count || 0;
  updateProgressBar();

  try {
    const response = await fetch(puzzle.box_image_url);
    boxBlob = await response.blob();
    boxPreview.onload = () => {
      if (boxViewer) boxViewer.reset();
    };
    boxPreview.src = URL.createObjectURL(boxBlob);
    boxContainer.classList.remove('hidden');
    boxHint.classList.remove('hidden');
    boxSavedBadge.classList.remove('hidden');
    boxUploadLabel.classList.add('hidden');
    checkReady();
  } catch (err) {
    console.error('Erro ao carregar imagem da caixa:', err);
  }
}

function updateProgressBar() {
  if (!currentPuzzle) return;
  const total = currentPuzzle.total_pieces || 1000;
  const percent = Math.min(100, Math.round((currentFoundCount / total) * 100));
  puzzleProgressStats.innerText = `${currentFoundCount} / ${total} peças (${percent}%)`;
  puzzleProgressBar.style.width = `${percent}%`;
}

// ==========================================
// 5. VISUALIZADOR INTERATIVO COM ZOOM, PAN E MIRA DE ALTA PRECISÃO
// ==========================================
class InteractiveImageViewer {
  constructor({
    viewport,
    layer,
    img,
    pin,
    zoomInBtn,
    zoomOutBtn,
    zoomResetBtn,
    zoomBadge,
    coordBadge,
    onSelect
  }) {
    this.viewport = viewport;
    this.layer = layer;
    this.img = img;
    this.pin = pin;
    this.zoomBadge = zoomBadge;
    this.coordBadge = coordBadge;
    this.onSelect = onSelect;

    this.scale = 1.0;
    this.minScale = 1.0;
    this.maxScale = 5.0;
    this.translateX = 0;
    this.translateY = 0;

    this.isDragging = false;
    this.hasMoved = false;
    this.startX = 0;
    this.startY = 0;
    this.initialTx = 0;
    this.initialTy = 0;

    this.selectedNormX = null;
    this.selectedNormY = null;

    this.initEvents(zoomInBtn, zoomOutBtn, zoomResetBtn);
  }

  reset() {
    this.scale = 1.0;
    this.translateX = 0;
    this.translateY = 0;
    this.applyTransform();
  }

  initEvents(zoomInBtn, zoomOutBtn, zoomResetBtn) {
    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.zoom(1.4);
      });
    }
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.zoom(1 / 1.4);
      });
    }
    if (zoomResetBtn) {
      zoomResetBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.reset();
      });
    }

    this.viewport.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.viewport.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.viewport.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.viewport.addEventListener('pointercancel', (e) => this.onPointerUp(e));

    this.viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.25 : 0.8;
      const rect = this.viewport.getBoundingClientRect();
      this.zoom(zoomFactor, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
  }

  zoom(factor, focalX = null, focalY = null) {
    const prevScale = this.scale;
    const newScale = Math.max(this.minScale, Math.min(this.maxScale, prevScale * factor));
    if (Math.abs(newScale - prevScale) < 0.01) return;

    const vpRect = this.viewport.getBoundingClientRect();
    const fx = (focalX !== null) ? focalX : vpRect.width / 2;
    const fy = (focalY !== null) ? focalY : vpRect.height / 2;

    this.translateX = fx - (fx - this.translateX) * (newScale / prevScale);
    this.translateY = fy - (fy - this.translateY) * (newScale / prevScale);

    this.scale = newScale;
    this.clampPan();
    this.applyTransform();
  }

  clampPan() {
    const vpW = this.viewport.clientWidth;
    const vpH = this.viewport.clientHeight;
    const layerW = this.layer.offsetWidth * this.scale;
    const layerH = this.layer.offsetHeight * this.scale;

    if (layerW <= vpW) {
      this.translateX = (vpW - layerW) / 2;
    } else {
      const minX = vpW - layerW;
      const maxX = 0;
      this.translateX = Math.min(maxX, Math.max(minX, this.translateX));
    }

    if (layerH <= vpH) {
      this.translateY = (vpH - layerH) / 2;
    } else {
      const minY = vpH - layerH;
      const maxY = 0;
      this.translateY = Math.min(maxY, Math.max(minY, this.translateY));
    }
  }

  applyTransform() {
    this.layer.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
    if (this.zoomBadge) {
      this.zoomBadge.innerText = `${Math.round(this.scale * 100)}%`;
    }
  }

  onPointerDown(e) {
    this.isDragging = true;
    this.hasMoved = false;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.initialTx = this.translateX;
    this.initialTy = this.translateY;
    try { this.viewport.setPointerCapture(e.pointerId); } catch (_) {}
  }

  onPointerMove(e) {
    if (!this.isDragging) return;
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;

    if (Math.hypot(dx, dy) > 5) {
      this.hasMoved = true;
    }

    if (this.hasMoved) {
      this.translateX = this.initialTx + dx;
      this.translateY = this.initialTy + dy;
      this.clampPan();
      this.layer.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
    }
  }

  onPointerUp(e) {
    if (!this.isDragging) return;
    this.isDragging = false;
    try { this.viewport.releasePointerCapture(e.pointerId); } catch (_) {}

    if (!this.hasMoved) {
      this.handleTap(e.clientX, e.clientY);
    }
  }

  handleTap(clientX, clientY) {
    const layerRect = this.layer.getBoundingClientRect();
    const clickX = clientX - layerRect.left;
    const clickY = clientY - layerRect.top;

    const normX = Math.max(0, Math.min(1, clickX / layerRect.width));
    const normY = Math.max(0, Math.min(1, clickY / layerRect.height));

    this.selectedNormX = normX;
    this.selectedNormY = normY;

    this.pin.style.left = `${normX * 100}%`;
    this.pin.style.top = `${normY * 100}%`;
    this.pin.classList.remove('hidden');

    if (this.coordBadge) {
      this.coordBadge.innerText = `📍 ${Math.round(normX * 100)}%, ${Math.round(normY * 100)}%`;
      this.coordBadge.classList.remove('hidden');
    }

    if (navigator.vibrate) navigator.vibrate(35);

    if (this.onSelect) {
      this.onSelect(normX, normY);
    }
  }
}

// Elementos do Tabuleiro
const boardInput = document.getElementById('boardInput');
const boardPreview = document.getElementById('boardPreview');
const boardContainer = document.getElementById('boardContainer');
const boardViewport = document.getElementById('boardViewport');
const boardTransformLayer = document.getElementById('boardTransformLayer');
const boardPin = document.getElementById('boardPin');
const boardHint = document.getElementById('boardHint');
const btnBoardZoomIn = document.getElementById('btnBoardZoomIn');
const btnBoardZoomOut = document.getElementById('btnBoardZoomOut');
const btnBoardZoomReset = document.getElementById('btnBoardZoomReset');
const boardZoomBadge = document.getElementById('boardZoomBadge');
const boardCoordBadge = document.getElementById('boardCoordBadge');

// Elementos da Caixa
const boxInput = document.getElementById('boxInput');
const boxPreview = document.getElementById('boxPreview');
const boxContainer = document.getElementById('boxContainer');
const boxViewport = document.getElementById('boxViewport');
const boxTransformLayer = document.getElementById('boxTransformLayer');
const targetPin = document.getElementById('targetPin');
const boxHint = document.getElementById('boxHint');
const btnBoxZoomIn = document.getElementById('btnBoxZoomIn');
const btnBoxZoomOut = document.getElementById('btnBoxZoomOut');
const btnBoxZoomReset = document.getElementById('btnBoxZoomReset');
const boxZoomBadge = document.getElementById('boxZoomBadge');
const boxCoordBadge = document.getElementById('boxCoordBadge');

// Instanciação dos visualizadores interativos
let boardViewer = null;
let boxViewer = null;

let boardPercentX = 0.5, boardPercentY = 0.5, hasSelectedBoard = false;
let targetPercentX = 0.5, targetPercentY = 0.5, hasSelectedBox = false;

boardViewer = new InteractiveImageViewer({
  viewport: boardViewport,
  layer: boardTransformLayer,
  img: boardPreview,
  pin: boardPin,
  zoomInBtn: btnBoardZoomIn,
  zoomOutBtn: btnBoardZoomOut,
  zoomResetBtn: btnBoardZoomReset,
  zoomBadge: boardZoomBadge,
  coordBadge: boardCoordBadge,
  onSelect: (nx, ny) => {
    boardPercentX = nx;
    boardPercentY = ny;
    hasSelectedBoard = true;
    checkReady();
  }
});

boxViewer = new InteractiveImageViewer({
  viewport: boxViewport,
  layer: boxTransformLayer,
  img: boxPreview,
  pin: targetPin,
  zoomInBtn: btnBoxZoomIn,
  zoomOutBtn: btnBoxZoomOut,
  zoomResetBtn: btnBoxZoomReset,
  zoomBadge: boxZoomBadge,
  coordBadge: boxCoordBadge,
  onSelect: (nx, ny) => {
    targetPercentX = nx;
    targetPercentY = ny;
    hasSelectedBox = true;
    checkReady();
  }
});

const tableInput = document.getElementById('tableInput');
const tablePreview = document.getElementById('tablePreview');
const tableContainer = document.getElementById('tableContainer');

const btnFind = document.getElementById('btnFind');
const loading = document.getElementById('loading');
const resultSection = document.getElementById('resultSection');
const slotRoiContainer = document.getElementById('slotRoiContainer');
const slotRoiImg = document.getElementById('slotRoiImg');
const shapeMatchTag = document.getElementById('shapeMatchTag');

let boardBlob = null;
let boxBlob = null;
let tableBlob = null;
let lastFoundResult = null;

async function compressImage(file, maxDimension = 1600) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Carregar Tabuleiro
boardInput.addEventListener('change', async (e) => {
  if (e.target.files && e.target.files[0]) {
    boardBlob = await compressImage(e.target.files[0]);
    boardPreview.onload = () => {
      boardViewer.reset();
    };
    boardPreview.src = URL.createObjectURL(boardBlob);
    boardContainer.classList.remove('hidden');
    boardHint.classList.remove('hidden');
    checkReady();
  }
});

// Carregar Imagem da Caixa (Manual)
boxInput.addEventListener('change', async (e) => {
  if (e.target.files && e.target.files[0]) {
    boxBlob = await compressImage(e.target.files[0]);
    boxPreview.onload = () => {
      boxViewer.reset();
    };
    boxPreview.onload = () => {
      if (boxViewer) boxViewer.reset();
    };
    boxPreview.src = URL.createObjectURL(boxBlob);
    boxContainer.classList.remove('hidden');
    boxHint.classList.remove('hidden');
    checkReady();
  }
});

// Peças Soltas na Mesa
tableInput.addEventListener('change', async (e) => {
  if (e.target.files && e.target.files[0]) {
    tableBlob = await compressImage(e.target.files[0]);
    tablePreview.src = URL.createObjectURL(tableBlob);
    tableContainer.classList.remove('hidden');
    checkReady();
  }
});

function checkReady() {
  const hasTarget = (boardBlob && hasSelectedBoard) || (boxBlob && (hasSelectedBox || currentPuzzle));
  if (hasTarget) {
    btnFind.disabled = !tableBlob;
  }
}

// Enviar Foto Manual para API
btnFind.addEventListener('click', async () => {
  if (!tableBlob) return;

  const backendUrl = apiUrlInput.value.replace(/\/$/, '');
  const formData = new FormData();
  formData.append('table_file', tableBlob, 'table.jpg');

  if (boardBlob && hasSelectedBoard) {
    formData.append('board_file', boardBlob, 'board.jpg');
    formData.append('board_x_ratio', boardPercentX);
    formData.append('board_y_ratio', boardPercentY);
  }

  if (boxBlob) {
    formData.append('box_file', boxBlob, 'box.jpg');
    formData.append('target_x_ratio', targetPercentX);
    formData.append('target_y_ratio', targetPercentY);
  }

  btnFind.disabled = true;
  loading.classList.remove('hidden');
  resultSection.classList.add('hidden');
  slotRoiContainer.classList.add('hidden');

  try {
    const res = await fetch(`${backendUrl}/api/find-piece`, {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Não foi possível encontrar a peça correspondente.');
    }

    const data = await res.json();
    lastFoundResult = data;

    document.getElementById('pieceCrop').src = `data:image/jpeg;base64,${data.piece_crop_base64}`;
    document.getElementById('highlightedTable').src = `data:image/jpeg;base64,${data.annotated_table_base64}`;
    document.getElementById('rotationTag').innerText = `Girar: ${data.rotation_deg}° para encaixar`;

    if (data.slot_roi_base64) {
      slotRoiImg.src = `data:image/jpeg;base64,${data.slot_roi_base64}`;
      if (data.shape_similarity) {
        shapeMatchTag.innerText = `Encaixe: ${data.shape_similarity}% compatível`;
      } else {
        shapeMatchTag.innerText = `Formato do buraco mapeado`;
      }
      slotRoiContainer.classList.remove('hidden');
    }

    if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
    resultSection.classList.remove('hidden');
    resultSection.scrollIntoView({ behavior: 'smooth' });

  } catch (error) {
    alert(`Aviso: ${error.message}`);
  } finally {
    loading.classList.add('hidden');
    btnFind.disabled = false;
  }
});

// Registrar Peça Encontrada no Histórico do Supabase
btnConfirmFound.addEventListener('click', async () => {
  if (!supabaseClient || !currentPuzzle) {
    alert('Selecione um quebra-cabeça conectado ao Supabase para registrar no histórico!');
    return;
  }

  try {
    btnConfirmFound.disabled = true;
    btnConfirmFound.innerText = 'Salvando...';

    const { error } = await supabaseClient.from('found_pieces').insert([{
      puzzle_id: currentPuzzle.id,
      piece_number: currentFoundCount + 1,
      rotation_deg: lastFoundResult ? lastFoundResult.rotation_deg : 0,
      shape_similarity: lastFoundResult ? lastFoundResult.shape_similarity : null
    }]);

    if (error) throw error;

    currentFoundCount += 1;
    updateProgressBar();
    btnConfirmFound.innerText = '✅ Registrado!';
    if (navigator.vibrate) navigator.vibrate(50);

  } catch (err) {
    alert(`Erro ao registrar peça: ${err.message}`);
    btnConfirmFound.innerText = '✅ Registrar no Histórico';
  } finally {
    btnConfirmFound.disabled = false;
  }
});

// ==========================================
// 6. SCANNER DE CÂMERA EM TEMPO REAL (AR)
// ==========================================
const btnOpenRealtimeScanner = document.getElementById('btnOpenRealtimeScanner');
const scannerModal = document.getElementById('scannerModal');
const btnCloseScanner = document.getElementById('btnCloseScanner');
const btnSwitchCamera = document.getElementById('btnSwitchCamera');
const scannerVideo = document.getElementById('scannerVideo');
const scannerOverlay = document.getElementById('scannerOverlay');
const scannerStatusText = document.getElementById('scannerStatusText');
const scannerLockAlert = document.getElementById('scannerLockAlert');
const scannerLockDetails = document.getElementById('scannerLockDetails');

let cameraStream = null;
let scanTimer = null;
let isProcessingFrame = false;
let currentFacingMode = 'environment'; // Traseira

function playSuccessChime() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
    osc.frequency.setValueAtTime(880.00, audioCtx.currentTime + 0.12); // A5
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.45);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.45);
  } catch (e) {}
}

btnOpenRealtimeScanner.addEventListener('click', async () => {
  const hasTarget = (boardBlob && hasSelectedBoard) || (boxBlob && (hasSelectedBox || currentPuzzle));
  if (!hasTarget) {
    alert('Por favor, primeiro selecione o buraco no Tabuleiro (Etapa 1) ou na Caixa (Etapa 2) para saber qual peça procurar!');
    return;
  }

  scannerModal.classList.remove('hidden');
  await startScannerCamera();
});

btnCloseScanner.addEventListener('click', () => {
  stopScannerCamera();
  scannerModal.classList.add('hidden');
});

btnSwitchCamera.addEventListener('click', async () => {
  currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';
  stopScannerCamera();
  await startScannerCamera();
});

async function startScannerCamera() {
  try {
    scannerStatusText.innerText = 'Inicializando visor da câmera...';
    scannerLockAlert.classList.add('hidden');

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: currentFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    scannerVideo.srcObject = cameraStream;
    await scannerVideo.play();

    scannerStatusText.innerText = 'Mova a câmera suavemente sobre as peças espalhadas...';
    startRealtimeLoop();

  } catch (err) {
    alert(`Não foi possível acessar a câmera: ${err.message}`);
    stopScannerCamera();
    scannerModal.classList.add('hidden');
  }
}

function stopScannerCamera() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  scannerVideo.srcObject = null;
}

function startRealtimeLoop() {
  if (scanTimer) clearInterval(scanTimer);

  // Amostragem a cada 900ms para alta fluidez sem sobrecarregar a rede
  scanTimer = setInterval(async () => {
    if (isProcessingFrame || !scannerVideo.videoWidth) return;
    isProcessingFrame = true;

    try {
      // 1. Captura o frame atual do vídeo em um canvas temporário
      const captureCanvas = document.createElement('canvas');
      const targetW = 960;
      const targetH = Math.round((scannerVideo.videoHeight * targetW) / scannerVideo.videoWidth);
      captureCanvas.width = targetW;
      captureCanvas.height = targetH;
      const ctx = captureCanvas.getContext('2d');
      ctx.drawImage(scannerVideo, 0, 0, targetW, targetH);

      // Converte para Blob JPEG leve (~150KB)
      const frameBlob = await new Promise(res => captureCanvas.toBlob(res, 'image/jpeg', 0.8));

      // 2. Prepara requisição para a API
      const backendUrl = apiUrlInput.value.replace(/\/$/, '');
      const formData = new FormData();
      formData.append('table_file', frameBlob, 'frame.jpg');

      if (boardBlob && hasSelectedBoard) {
        formData.append('board_file', boardBlob, 'board.jpg');
        formData.append('board_x_ratio', boardPercentX);
        formData.append('board_y_ratio', boardPercentY);
      }

      if (boxBlob) {
        formData.append('box_file', boxBlob, 'box.jpg');
        formData.append('target_x_ratio', targetPercentX);
        formData.append('target_y_ratio', targetPercentY);
      }

      const res = await fetch(`${backendUrl}/api/find-piece`, {
        method: 'POST',
        body: formData
      });

      if (res.ok) {
        const data = await res.json();
        renderARMatch(data, targetW, targetH);
      } else {
        clearAROverlay();
      }

    } catch (e) {
      // Frame ignorado silenciosamente para manter streaming contínuo
    } finally {
      isProcessingFrame = false;
    }
  }, 900);
}

function renderARMatch(data, frameW, frameH) {
  const overlay = scannerOverlay;
  overlay.width = scannerVideo.clientWidth;
  overlay.height = scannerVideo.clientHeight;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const scaleX = overlay.width / frameW;
  const scaleY = overlay.height / frameH;

  const [bx, by, bw, bh] = data.bbox;
  const [cx, cy] = data.centroid;

  const screenCx = cx * scaleX;
  const screenCy = cy * scaleY;
  const screenW = bw * scaleX;
  const screenH = bh * scaleY;
  const radius = Math.max(screenW, screenH) * 0.9;

  // Círculo verde neon pulsante no visor
  ctx.beginPath();
  ctx.arc(screenCx, screenCy, radius, 0, 2 * Math.PI);
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#10b981';
  ctx.shadowColor = '#10b981';
  ctx.shadowBlur = 18;
  ctx.stroke();

  // Mira central
  ctx.beginPath();
  ctx.moveTo(screenCx - 20, screenCy);
  ctx.lineTo(screenCx + 20, screenCy);
  ctx.moveTo(screenCx, screenCy - 20);
  ctx.lineTo(screenCx, screenCy + 20);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  // Feedback auditivo e tátil
  playSuccessChime();
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);

  // Alerta Visual no HUD
  scannerLockAlert.classList.remove('hidden');
  let detailText = `Girar ${data.rotation_deg}° para encaixar`;
  if (data.shape_similarity) {
    detailText += ` • Encaixe: ${data.shape_similarity}%`;
  }
  scannerLockDetails.innerText = detailText;
  scannerStatusText.innerText = '🎯 PEÇA ENCONTRADA NA MIRA! Segure a câmera estável.';
}

function clearAROverlay() {
  const overlay = scannerOverlay;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  scannerLockAlert.classList.add('hidden');
  scannerStatusText.innerText = 'Rastreando mesa... Aproxime ou afaste a câmera suavemente.';
}

// Inicia conexão do Supabase ao carregar página
window.addEventListener('DOMContentLoaded', () => {
  initSupabase();
});
