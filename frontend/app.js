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
// 4. ELEMENTOS DO FLUXO PRINCIPAL
// ==========================================
// Tabuleiro em montagem (Etapa 1)
const boardInput = document.getElementById('boardInput');
const boardPreview = document.getElementById('boardPreview');
const boardContainer = document.getElementById('boardContainer');
const boardPin = document.getElementById('boardPin');
const boardHint = document.getElementById('boardHint');

// Imagem da Caixa (Etapa 2)
const boxInput = document.getElementById('boxInput');
const boxPreview = document.getElementById('boxPreview');
const boxContainer = document.getElementById('boxContainer');
const targetPin = document.getElementById('targetPin');
const boxHint = document.getElementById('boxHint');

// Peças na Mesa (Etapa 3)
const tableInput = document.getElementById('tableInput');
const tablePreview = document.getElementById('tablePreview');
const tableContainer = document.getElementById('tableContainer');

// Ações e Resultados
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

// ==========================================
// 5. OTIMIZADOR DE IMAGEM CLIENT-SIDE
// ==========================================
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

// ------------------------------------------
// 1. Tabuleiro em Montagem (Com o Buraco)
// ------------------------------------------
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

// ------------------------------------------
// 2. Imagem da Caixa (Cores / Arte)
// ------------------------------------------
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

// ------------------------------------------
// 3. Peças Soltas na Mesa
// ------------------------------------------
tableInput.addEventListener('change', async (e) => {
  if (e.target.files && e.target.files[0]) {
    tableBlob = await compressImage(e.target.files[0]);
    tablePreview.src = URL.createObjectURL(tableBlob);
    tableContainer.classList.remove('hidden');
    checkReady();
  }
});

function checkReady() {
  const hasTarget = (boardBlob && hasSelectedBoard) || (boxBlob && hasSelectedBox);
  if (tableBlob && hasTarget) {
    btnFind.disabled = false;
  }
}

// ==========================================
// 6. ENVIAR PARA O MOTOR DE IA NA NUVEM
// ==========================================
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

  if (boxBlob && hasSelectedBox) {
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

    // Atualiza resultados visuais
    document.getElementById('pieceCrop').src = `data:image/jpeg;base64,${data.piece_crop_base64}`;
    document.getElementById('highlightedTable').src = `data:image/jpeg;base64,${data.annotated_table_base64}`;
    document.getElementById('rotationTag').innerText = `Girar: ${data.rotation_deg}° para encaixar`;

    // Se o contorno do buraco foi extraído do tabuleiro
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
