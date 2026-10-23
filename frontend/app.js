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
  const url = localStorage.getItem('puzzle_supabase_url');
  const key = localStorage.getItem('puzzle_supabase_key');

  if (url && key && window.supabase) {
    try {
      supabaseClient = window.supabase.createClient(url, key);
      supabaseStatusLabel.innerText = 'Supabase Conectado 🟢';
      loadPuzzlesFromSupabase();
    } catch (e) {
      console.error('Erro ao conectar ao Supabase:', e);
      supabaseStatusLabel.innerText = 'Erro Supabase ⚠️';
    }
  } else {
    supabaseStatusLabel.innerText = 'Conectar Supabase ⚡';
  }
}

btnOpenSupabaseModal.addEventListener('click', () => {
  supabaseUrlInput.value = localStorage.getItem('puzzle_supabase_url') || '';
  supabaseKeyInput.value = localStorage.getItem('puzzle_supabase_key') || '';
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
  if (!supabaseClient) {
    alert('Conecte ao Supabase primeiro no botão "⚡ Supabase" para salvar na nuvem!');
    supabaseModal.classList.remove('hidden');
    return;
  }
  newPuzzleModal.classList.remove('hidden');
});

btnCloseNewPuzzleModal.addEventListener('click', () => {
  newPuzzleModal.classList.add('hidden');
});

// Cadastrar Novo Quebra-Cabeça no Supabase
btnCreatePuzzleSubmit.addEventListener('click', async () => {
  const name = newPuzzleName.value.trim();
  const total = parseInt(newPuzzleTotal.value, 10) || 1000;
  const file = newPuzzleBoxFile.files[0];

  if (!name || !file) {
    alert('Informe o nome do quebra-cabeça e selecione a foto da caixa.');
    return;
  }

  btnCreatePuzzleSubmit.disabled = true;
  btnCreatePuzzleSubmit.innerText = 'Enviando imagem para a nuvem...';

  try {
    // 1. Comprime a foto da caixa
    const compressedBlob = await compressImage(file);
    const fileName = `box_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;

    // 2. Upload para Supabase Storage
    const { error: uploadError } = await supabaseClient.storage
      .from('puzzle-images')
      .upload(fileName, compressedBlob, { contentType: 'image/jpeg' });

    if (uploadError) throw uploadError;

    // 3. Obtém URL pública
    const { data: publicUrlData } = supabaseClient.storage
      .from('puzzle-images')
      .getPublicUrl(fileName);

    const boxImageUrl = publicUrlData.publicUrl;

    // 4. Insere na tabela 'puzzles'
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

// Carregar lista de quebra-cabeças
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
      onPuzzleSelected(autoSelectId, data);
    }
  } catch (err) {
    console.error('Falha ao carregar puzzles:', err);
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

  // Carrega contagem de peças já encontradas
  const { count } = await supabaseClient
    .from('found_pieces')
    .select('*', { count: 'exact', head: true })
    .eq('puzzle_id', puzzle.id);

  currentFoundCount = count || 0;
  updateProgressBar();

  // Baixa a imagem da caixa automaticamente
  try {
    const response = await fetch(puzzle.box_image_url);
    boxBlob = await response.blob();
    boxPreview.src = URL.createObjectURL(boxBlob);
    boxContainer.classList.remove('hidden');
    boxHint.classList.remove('hidden');
    boxSavedBadge.classList.remove('hidden');
    boxUploadLabel.classList.add('hidden');
    checkReady();
  } catch (err) {
    console.error('Erro ao carregar imagem da caixa da nuvem:', err);
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
// 5. ELEMENTOS DO FLUXO PRINCIPAL
// ==========================================
const boardInput = document.getElementById('boardInput');
const boardPreview = document.getElementById('boardPreview');
const boardContainer = document.getElementById('boardContainer');
const boardPin = document.getElementById('boardPin');
const boardHint = document.getElementById('boardHint');

const boxInput = document.getElementById('boxInput');
const boxPreview = document.getElementById('boxPreview');
const boxContainer = document.getElementById('boxContainer');
const targetPin = document.getElementById('targetPin');
const boxHint = document.getElementById('boxHint');

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

let boardPercentX = 0.5, boardPercentY = 0.5, hasSelectedBoard = false;
let targetPercentX = 0.5, targetPercentY = 0.5, hasSelectedBox = false;

let lastFoundResult = null;

// Otimizador de imagem client-side (1600px max)
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

// Tabuleiro Sendo Montado
boardInput.addEventListener('change', async (e) => {
  if (e.target.files && e.target.files[0]) {
    boardBlob = await compressImage(e.target.files[0]);
    boardPreview.src = URL.createObjectURL(boardBlob);
    boardContainer.classList.remove('hidden');
    boardHint.classList.remove('hidden');
    checkReady();
  }
});

function handleBoardSelection(clientX, clientY) {
  const rect = boardPreview.getBoundingClientRect();
  const clickX = clientX - rect.left;
  const clickY = clientY - rect.top;

  boardPercentX = Math.max(0, Math.min(1, clickX / rect.width));
  boardPercentY = Math.max(0, Math.min(1, clickY / rect.height));

  boardPin.style.left = `${clickX}px`;
  boardPin.style.top = `${clickY}px`;
  boardPin.classList.remove('hidden');

  if (navigator.vibrate) navigator.vibrate(35);
  hasSelectedBoard = true;
  checkReady();
}

boardPreview.addEventListener('click', (e) => handleBoardSelection(e.clientX, e.clientY));
boardPreview.addEventListener('touchstart', (e) => {
  if (e.touches && e.touches[0]) handleBoardSelection(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: true });

// Imagem da Caixa (Manual)
boxInput.addEventListener('change', async (e) => {
  if (e.target.files && e.target.files[0]) {
    boxBlob = await compressImage(e.target.files[0]);
    boxPreview.src = URL.createObjectURL(boxBlob);
    boxContainer.classList.remove('hidden');
    boxHint.classList.remove('hidden');
    checkReady();
  }
});

function handleBoxSelection(clientX, clientY) {
  const rect = boxPreview.getBoundingClientRect();
  const clickX = clientX - rect.left;
  const clickY = clientY - rect.top;

  targetPercentX = Math.max(0, Math.min(1, clickX / rect.width));
  targetPercentY = Math.max(0, Math.min(1, clickY / rect.height));

  targetPin.style.left = `${clickX}px`;
  targetPin.style.top = `${clickY}px`;
  targetPin.classList.remove('hidden');

  if (navigator.vibrate) navigator.vibrate(30);
  hasSelectedBox = true;
  checkReady();
}

boxPreview.addEventListener('click', (e) => handleBoxSelection(e.clientX, e.clientY));
boxPreview.addEventListener('touchstart', (e) => {
  if (e.touches && e.touches[0]) handleBoxSelection(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: true });

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
  if (tableBlob && hasTarget) {
    btnFind.disabled = false;
  }
}

// Enviar para a Nuvem (Render API)
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

    // Atualiza resultados visuais
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

// Inicia conexão do Supabase ao carregar página
window.addEventListener('DOMContentLoaded', () => {
  initSupabase();
});
