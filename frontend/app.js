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
// 2. AVISOS (TOAST) E UTILITÁRIOS
// ==========================================
const toastRegion = document.getElementById('toastRegion');

const TOAST_STYLES = {
  info: 'bg-slate-100 text-slate-950',
  success: 'bg-emerald-400 text-slate-950',
  error: 'bg-rose-500 text-white',
};

function notify(message, type = 'info', timeoutMs = 4500) {
  const el = document.createElement('div');
  el.className = `toast-enter pointer-events-auto max-w-md w-full sm:w-auto px-4 py-3 rounded-xl shadow-2xl text-sm font-semibold ${TOAST_STYLES[type] || TOAST_STYLES.info}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  toastRegion.appendChild(el);
  setTimeout(() => el.remove(), timeoutMs);
}

function show(el, display = 'block') {
  el.classList.remove('hidden');
  if (display !== 'block') el.classList.add(display);
}

function hide(el, display = 'block') {
  el.classList.add('hidden');
  if (display !== 'block') el.classList.remove(display);
}

// Troca a URL de um <img> liberando a anterior criada com createObjectURL
function setObjectUrl(img, blob) {
  if (img.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
  const url = URL.createObjectURL(blob);
  img.dataset.objectUrl = url;
  img.src = url;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Semelhança de formato (%) abaixo da qual o contorno do buraco não é exibido como compatível
const MIN_SHAPE_TO_SHOW = 60;

// Texto de instrução para a rotação horária retornada pela API
function rotationLabel(deg) {
  switch (((deg % 360) + 360) % 360) {
    case 90: return 'Gire 90° no sentido horário';
    case 180: return 'Gire meia volta (180°)';
    case 270: return 'Gire 90° no sentido anti-horário';
    default: return 'Encaixa sem girar';
  }
}

// ==========================================
// 3. LÓGICA DE INSTALAÇÃO DO APP (DESKTOP & MOBILE)
// ==========================================
let deferredPrompt = null;
const btnInstall = document.getElementById('btnInstall');
const installedBadge = document.getElementById('installedBadge');
const iosInstallBanner = document.getElementById('iosInstallBanner');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  show(btnInstall, 'flex');
});

btnInstall.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  console.log('Resultado da instalação:', outcome);
  deferredPrompt = null;
  hide(btnInstall, 'flex');
});

window.addEventListener('appinstalled', () => {
  hide(btnInstall, 'flex');
  show(installedBadge, 'flex');
});

const isIos = /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase()) && !window.MSStream;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

if (isIos && !isStandalone) show(iosInstallBanner, 'flex');
if (isStandalone) show(installedBadge, 'flex');

document.getElementById('btnCloseIosBanner').addEventListener('click', () => iosInstallBanner.remove());

// ==========================================
// 4. CONFIGURAÇÕES E STATUS DOS SERVIÇOS
// ==========================================
const DEFAULT_API_URL = 'https://puzzle-finder-api.onrender.com';
const DEFAULT_SUPABASE_URL = 'https://gfjxcsvxhaojbtuixpjh.supabase.co';
const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmanhjc3Z4aGFvamJ0dWl4cGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyMzU5NjYsImV4cCI6MjEwNjgxMTk2Nn0.gKx3hutXIkemUfVR_O7MFnibpUxY_tYslNSY1D1M4ds';

const settingsDialog = document.getElementById('settingsDialog');
const btnOpenSettings = document.getElementById('btnOpenSettings');
const btnSaveSettings = document.getElementById('btnSaveSettings');
const btnResetSettings = document.getElementById('btnResetSettings');
const apiUrlInput = document.getElementById('apiUrl');
const supabaseUrlInput = document.getElementById('supabaseUrlInput');
const supabaseKeyInput = document.getElementById('supabaseKeyInput');
const apiStatusText = document.getElementById('apiStatusText');
const supabaseStatusLabel = document.getElementById('supabaseStatusLabel');
const statusDot = document.getElementById('statusDot');
const apiNotice = document.getElementById('apiNotice');
const apiNoticeText = document.getElementById('apiNoticeText');

const STATUS_COLORS = { ok: 'bg-emerald-400', warn: 'bg-amber-400', error: 'bg-rose-500', pending: 'bg-slate-500' };
const serviceStatus = { api: 'pending', db: 'pending' };

function setServiceStatus(service, state, text) {
  serviceStatus[service] = state;
  const label = service === 'api' ? apiStatusText : supabaseStatusLabel;
  label.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = `w-2 h-2 rounded-full ${STATUS_COLORS[state]}`;
  label.append(dot, document.createTextNode(text));
  label.className = `flex items-center gap-2 font-medium ${state === 'ok' ? 'text-emerald-300' : state === 'error' ? 'text-rose-300' : state === 'warn' ? 'text-amber-200' : 'text-slate-400'}`;

  // Ponto no botão de configurações reflete o pior status
  const states = Object.values(serviceStatus);
  const worst = states.includes('error') ? 'error' : states.includes('warn') ? 'warn' : states.includes('pending') ? 'pending' : 'ok';
  statusDot.className = `absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full ring-2 ring-slate-950 ${STATUS_COLORS[worst]}`;
  statusDot.title = worst === 'ok' ? 'Tudo conectado' : 'Algum serviço com problema: abra as configurações';
}

function getApiUrl() {
  return (localStorage.getItem('puzzle_backend_url') || DEFAULT_API_URL).replace(/\/$/, '');
}

// A API só atende usuários logados: envia o token da sessão do Supabase
async function authHeaders() {
  if (!supabaseClient) return {};
  const { data } = await supabaseClient.auth.getSession();
  const token = data.session && data.session.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiErrorMessage(res, fallback) {
  if (res.status === 401) return 'Sua sessão expirou. Saia e entre de novo.';
  const err = await res.json().catch(() => ({}));
  return err.detail || fallback;
}

let apiWakeup = null;

// O plano gratuito do Render hiberna: a primeira resposta pode levar ~1 min
async function checkApiHealth() {
  setServiceStatus('api', 'pending', 'Verificando…');
  const slowTimer = setTimeout(() => {
    setServiceStatus('api', 'warn', 'Acordando…');
    apiNoticeText.textContent = 'Acordando o servidor de análise… a primeira busca pode levar até 1 minuto.';
    show(apiNotice, 'flex');
  }, 2500);
  try {
    const res = await fetchWithTimeout(`${getApiUrl()}/healthz`, {}, 75000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setServiceStatus('api', 'ok', 'Online');
    hide(apiNotice, 'flex');
    return true;
  } catch (err) {
    console.error('API indisponível:', err);
    setServiceStatus('api', 'error', 'Offline');
    apiNoticeText.textContent = 'Servidor de análise indisponível. Confira o endereço em Configurações.';
    show(apiNotice, 'flex');
    return false;
  } finally {
    clearTimeout(slowTimer);
  }
}

btnOpenSettings.addEventListener('click', () => {
  apiUrlInput.value = getApiUrl();
  supabaseUrlInput.value = localStorage.getItem('puzzle_supabase_url') || DEFAULT_SUPABASE_URL;
  supabaseKeyInput.value = localStorage.getItem('puzzle_supabase_key') || DEFAULT_SUPABASE_KEY;
  settingsDialog.showModal();
});

btnSaveSettings.addEventListener('click', () => {
  const api = apiUrlInput.value.trim();
  const url = supabaseUrlInput.value.trim();
  const key = supabaseKeyInput.value.trim();

  if (!api || !url || !key) {
    notify('Preencha o endereço da API, a URL e a anon key do Supabase.', 'error');
    return;
  }

  localStorage.setItem('puzzle_backend_url', api);
  localStorage.setItem('puzzle_supabase_url', url);
  localStorage.setItem('puzzle_supabase_key', key);
  settingsDialog.close();
  apiWakeup = checkApiHealth();
  initSupabase();
});

btnResetSettings.addEventListener('click', () => {
  ['puzzle_backend_url', 'puzzle_supabase_url', 'puzzle_supabase_key'].forEach((k) => localStorage.removeItem(k));
  apiUrlInput.value = DEFAULT_API_URL;
  supabaseUrlInput.value = DEFAULT_SUPABASE_URL;
  supabaseKeyInput.value = DEFAULT_SUPABASE_KEY;
  settingsDialog.close();
  apiWakeup = checkApiHealth();
  initSupabase();
});

// ==========================================
// 5. INTEGRAÇÃO COM SUPABASE (LOGIN, BANCO & STORAGE)
// ==========================================
let supabaseClient = null;
let currentUser = null;
let puzzles = [];
let currentPuzzle = null;
let currentFoundCount = 0;

const puzzleSelect = document.getElementById('puzzleSelect');
const btnNewPuzzle = document.getElementById('btnNewPuzzle');
const newPuzzleModal = document.getElementById('newPuzzleModal');
const newPuzzleForm = document.getElementById('newPuzzleForm');
const btnCloseNewPuzzleModal = document.getElementById('btnCloseNewPuzzleModal');
const btnCreatePuzzleSubmit = document.getElementById('btnCreatePuzzleSubmit');
const newPuzzleName = document.getElementById('newPuzzleName');
const newPuzzleTotal = document.getElementById('newPuzzleTotal');
const newPuzzleBoxFile = document.getElementById('newPuzzleBoxFile');

const puzzleProgressContainer = document.getElementById('puzzleProgressContainer');
const puzzleProgressName = document.getElementById('puzzleProgressName');
const puzzleProgressStats = document.getElementById('puzzleProgressStats');
const puzzleProgressBar = document.getElementById('puzzleProgressBar');
const puzzleProgressTrack = document.getElementById('puzzleProgressTrack');
const boxSavedBadge = document.getElementById('boxSavedBadge');
const btnConfirmFound = document.getElementById('btnConfirmFound');
const btnConfirmFoundText = document.getElementById('btnConfirmFoundText');

const authScreen = document.getElementById('authScreen');
const appRoot = document.getElementById('appRoot');
const authLoading = document.getElementById('authLoading');
const loginForm = document.getElementById('loginForm');
const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const loginError = document.getElementById('loginError');
const btnLogin = document.getElementById('btnLogin');
const btnTogglePassword = document.getElementById('btnTogglePassword');
const btnForgotPassword = document.getElementById('btnForgotPassword');
const newPasswordForm = document.getElementById('newPasswordForm');
const newPassword = document.getElementById('newPassword');
const newPasswordError = document.getElementById('newPasswordError');
const btnSaveNewPassword = document.getElementById('btnSaveNewPassword');
const accountEmail = document.getElementById('accountEmail');
const btnLogout = document.getElementById('btnLogout');

let authSubscription = null;

function initSupabase() {
  const url = localStorage.getItem('puzzle_supabase_url') || DEFAULT_SUPABASE_URL;
  const key = localStorage.getItem('puzzle_supabase_key') || DEFAULT_SUPABASE_KEY;

  if (authSubscription) {
    authSubscription.unsubscribe();
    authSubscription = null;
  }

  if (!window.supabase) {
    supabaseClient = null;
    setServiceStatus('db', 'error', 'Biblioteca não carregou');
    showAuthView('login', 'Não foi possível carregar o login. Confira a conexão e recarregue a página.');
    return;
  }

  try {
    supabaseClient = window.supabase.createClient(url, key);
  } catch (e) {
    console.error('Erro ao conectar ao Supabase:', e);
    supabaseClient = null;
    setServiceStatus('db', 'error', 'Erro de conexão');
    showAuthView('login', 'Configuração do banco inválida.');
    return;
  }

  // INITIAL_SESSION chega logo após criar o cliente: decide entre login e app.
  // O Supabase pede para não aguardar outras chamadas dentro deste callback, daí o setTimeout.
  const { data } = supabaseClient.auth.onAuthStateChange((event, session) => {
    setTimeout(() => handleAuthChange(event, session), 0);
  });
  authSubscription = data.subscription;
}

function handleAuthChange(event, session) {
  if (event === 'PASSWORD_RECOVERY') {
    showAuthView('newPassword');
    return;
  }
  const user = session ? session.user : null;
  if (!user) {
    if (currentUser || event === 'INITIAL_SESSION' || event === 'SIGNED_OUT') onSignedOut();
    return;
  }
  // Atualizações de token não mudam o usuário: nada a recarregar
  if (currentUser && currentUser.id === user.id) {
    currentUser = user;
    return;
  }
  onSignedIn(user);
}

function showAuthView(view, errorMessage = '') {
  hide(appRoot);
  show(authScreen, 'flex');
  hide(authLoading, 'flex');
  loginForm.classList.toggle('hidden', view !== 'login');
  newPasswordForm.classList.toggle('hidden', view !== 'newPassword');
  const errorEl = view === 'newPassword' ? newPasswordError : loginError;
  errorEl.textContent = errorMessage;
  errorEl.classList.toggle('hidden', !errorMessage);
  (view === 'newPassword' ? newPassword : (loginEmail.value ? loginPassword : loginEmail)).focus();
}

function onSignedIn(user) {
  currentUser = user;
  accountEmail.textContent = user.email || '';
  hide(authScreen, 'flex');
  show(appRoot);
  loginForm.reset();
  loadPuzzlesFromSupabase();
}

function onSignedOut() {
  currentUser = null;
  puzzles = [];
  currentPuzzle = null;
  hide(puzzleProgressContainer);
  hide(boxSavedBadge);
  hide(resultSection);
  clearBoxImage();
  puzzleSelect.innerHTML = '<option value="">Carregando…</option>';
  setServiceStatus('db', 'pending', 'Desconectado');
  if (settingsDialog.open) settingsDialog.close();
  showAuthView('login');
}

const AUTH_ERRORS = {
  'Invalid login credentials': 'E-mail ou senha incorretos.',
  'Email not confirmed': 'Confirme seu e-mail pelo link que enviamos antes de entrar.',
  'User banned': 'Esta conta está bloqueada.',
};

function translateAuthError(error) {
  if (!error) return '';
  if (AUTH_ERRORS[error.message]) return AUTH_ERRORS[error.message];
  if (/fetch|network/i.test(error.message)) return 'Sem conexão com o servidor. Confira a internet.';
  if (/password/i.test(error.message) && /(least|characters|weak)/i.test(error.message)) return 'Senha fraca: use pelo menos 8 caracteres.';
  return error.message;
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!supabaseClient) return;
  const email = loginEmail.value.trim();
  const password = loginPassword.value;
  if (!email || !password) {
    showAuthView('login', 'Informe e-mail e senha.');
    return;
  }

  btnLogin.disabled = true;
  btnLogin.textContent = 'Entrando…';
  hide(loginError);
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  btnLogin.disabled = false;
  btnLogin.textContent = 'Entrar';
  if (error) {
    showAuthView('login', translateAuthError(error));
    loginPassword.select();
  }
  // Sucesso: onAuthStateChange (SIGNED_IN) abre o app
});

btnTogglePassword.addEventListener('click', () => {
  const visible = loginPassword.type === 'text';
  loginPassword.type = visible ? 'password' : 'text';
  btnTogglePassword.setAttribute('aria-pressed', String(!visible));
  btnTogglePassword.setAttribute('aria-label', visible ? 'Mostrar senha' : 'Ocultar senha');
});

btnForgotPassword.addEventListener('click', async () => {
  const email = loginEmail.value.trim();
  if (!email || !loginEmail.checkValidity()) {
    showAuthView('login', 'Digite seu e-mail acima e toque de novo em “Esqueci minha senha”.');
    loginEmail.focus();
    return;
  }
  btnForgotPassword.disabled = true;
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/`,
  });
  btnForgotPassword.disabled = false;
  if (error) {
    showAuthView('login', translateAuthError(error));
  } else {
    notify('Se existir uma conta com esse e-mail, enviamos um link para criar uma nova senha.', 'success', 7000);
  }
});

newPasswordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (newPassword.value.length < 8) {
    showAuthView('newPassword', 'Use pelo menos 8 caracteres.');
    return;
  }
  btnSaveNewPassword.disabled = true;
  const { data, error } = await supabaseClient.auth.updateUser({ password: newPassword.value });
  btnSaveNewPassword.disabled = false;
  if (error) {
    showAuthView('newPassword', translateAuthError(error));
    return;
  }
  newPasswordForm.reset();
  notify('Senha atualizada.', 'success');
  onSignedIn(data.user);
});

btnLogout.addEventListener('click', async () => {
  btnLogout.disabled = true;
  await supabaseClient.auth.signOut();
  btnLogout.disabled = false;
  onSignedOut();
});

btnNewPuzzle.addEventListener('click', () => {
  if (!supabaseClient) {
    notify('Banco de dados desconectado. Confira em Configurações.', 'error');
    return;
  }
  newPuzzleModal.showModal();
  newPuzzleName.focus();
});

btnCloseNewPuzzleModal.addEventListener('click', () => newPuzzleModal.close());

newPuzzleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = newPuzzleName.value.trim();
  const total = parseInt(newPuzzleTotal.value, 10);
  const file = newPuzzleBoxFile.files[0];

  if (!name || !file || !(total > 1)) {
    newPuzzleForm.reportValidity();
    return;
  }

  btnCreatePuzzleSubmit.disabled = true;
  btnCreatePuzzleSubmit.textContent = 'Enviando imagem…';

  try {
    const compressedBlob = await compressImage(file);
    // Bucket privado: cada usuário grava na própria pasta
    const filePath = `${currentUser.id}/box_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;

    const { error: uploadError } = await supabaseClient.storage
      .from('puzzle-images')
      .upload(filePath, compressedBlob, { contentType: 'image/jpeg' });

    if (uploadError) throw uploadError;

    const { data: insertData, error: insertError } = await supabaseClient
      .from('puzzles')
      .insert([{ name, total_pieces: total, box_image_path: filePath }])
      .select()
      .single();

    if (insertError) throw insertError;

    notify(`“${name}” cadastrado.`, 'success');
    newPuzzleModal.close();
    newPuzzleForm.reset();

    await loadPuzzlesFromSupabase(insertData.id);

  } catch (err) {
    notify(`Não foi possível salvar: ${err.message}`, 'error', 7000);
  } finally {
    btnCreatePuzzleSubmit.disabled = false;
    btnCreatePuzzleSubmit.textContent = 'Salvar quebra-cabeça';
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

    puzzles = data;
    setServiceStatus('db', 'ok', 'Conectado');

    puzzleSelect.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = data.length ? 'Nenhum (modo avulso)' : 'Nenhum cadastrado ainda (modo avulso)';
    puzzleSelect.appendChild(none);
    data.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} · ${p.total_pieces} peças`;
      puzzleSelect.appendChild(opt);
    });

    if (autoSelectId) {
      puzzleSelect.value = autoSelectId;
      const found = data.find(p => p.id === autoSelectId);
      if (found) onPuzzleSelected(found);
    }
  } catch (err) {
    console.error('Falha ao carregar puzzles do Supabase:', err);
    setServiceStatus('db', 'error', 'Sem acesso');
    puzzleSelect.innerHTML = '<option value="">Sem quebra-cabeça (modo avulso)</option>';
  }
}

puzzleSelect.addEventListener('change', (e) => {
  const selected = puzzles.find(p => p.id === e.target.value);
  if (!selected) {
    currentPuzzle = null;
    hide(puzzleProgressContainer);
    hide(boxSavedBadge);
    clearBoxImage();
    return;
  }
  onPuzzleSelected(selected);
});

async function onPuzzleSelected(puzzle) {
  currentPuzzle = puzzle;
  show(puzzleProgressContainer);
  puzzleProgressName.textContent = puzzle.name;
  currentFoundCount = 0;
  updateProgressBar();

  const [countResult, imageResult] = await Promise.allSettled([
    supabaseClient
      .from('found_pieces')
      .select('*', { count: 'exact', head: true })
      .eq('puzzle_id', puzzle.id),
    downloadBoxImage(puzzle),
  ]);

  // O usuário pode ter trocado de quebra-cabeça enquanto carregava
  if (currentPuzzle !== puzzle) return;

  if (countResult.status === 'fulfilled') {
    currentFoundCount = countResult.value.count || 0;
    updateProgressBar();
  }

  if (imageResult.status === 'fulfilled') {
    loadBoxImage(imageResult.value);
    show(boxSavedBadge);
  } else {
    console.error('Erro ao carregar imagem da caixa:', imageResult.reason);
    notify('Não foi possível carregar a imagem da caixa salva.', 'error');
  }
}

// Bucket privado: baixa pela sessão do usuário (cadastros antigos podem ter só a URL pública)
async function downloadBoxImage(puzzle) {
  if (puzzle.box_image_path) {
    const { data, error } = await supabaseClient.storage.from('puzzle-images').download(puzzle.box_image_path);
    if (error) throw error;
    return data;
  }
  const res = await fetch(puzzle.box_image_url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

function updateProgressBar() {
  if (!currentPuzzle) return;
  const total = currentPuzzle.total_pieces || 1000;
  const percent = Math.min(100, Math.round((currentFoundCount / total) * 100));
  puzzleProgressStats.textContent = `${currentFoundCount} / ${total} peças · ${percent}%`;
  puzzleProgressBar.style.width = `${percent}%`;
  puzzleProgressTrack.setAttribute('aria-valuenow', String(percent));
}

// ==========================================
// 6. VISUALIZADOR INTERATIVO COM ZOOM, PAN E MIRA DE ALTA PRECISÃO
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

    // Ponteiros ativos (permite pinça com dois dedos)
    this.pointers = new Map();
    this.hasMoved = false;
    this.startX = 0;
    this.startY = 0;
    this.initialTx = 0;
    this.initialTy = 0;
    this.pinchStartDist = 0;
    this.pinchStartScale = 1;

    this.selectedNormX = null;
    this.selectedNormY = null;

    this.initEvents(zoomInBtn, zoomOutBtn, zoomResetBtn);
  }

  reset() {
    this.scale = 1.0;
    this.translateX = 0;
    this.translateY = 0;
    this.clampPan();
    this.applyTransform();
  }

  // Remove a marcação (nova foto carregada)
  clearSelection() {
    this.selectedNormX = null;
    this.selectedNormY = null;
    this.pin.classList.add('hidden');
    if (this.coordBadge) hide(this.coordBadge, 'flex');
  }

  initEvents(zoomInBtn, zoomOutBtn, zoomResetBtn) {
    zoomInBtn.addEventListener('click', (e) => {
      e.preventDefault();
      this.zoom(1.4);
    });
    zoomOutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      this.zoom(1 / 1.4);
    });
    zoomResetBtn.addEventListener('click', (e) => {
      e.preventDefault();
      this.reset();
    });

    this.viewport.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.viewport.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.viewport.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.viewport.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));

    this.viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.25 : 0.8;
      const rect = this.viewport.getBoundingClientRect();
      this.zoom(zoomFactor, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    window.addEventListener('resize', () => {
      this.clampPan();
      this.applyTransform();
    });
  }

  zoom(factor, focalX = null, focalY = null, baseScale = null) {
    const prevScale = this.scale;
    const target = (baseScale ?? prevScale) * factor;
    const newScale = Math.max(this.minScale, Math.min(this.maxScale, target));
    if (Math.abs(newScale - prevScale) < 0.001) return;

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

    // O viewport centraliza a camada via flexbox; o transform age a partir dessa posição
    const baseX = this.layer.offsetLeft;
    const baseY = this.layer.offsetTop;

    if (layerW <= vpW) {
      this.translateX = (vpW - layerW) / 2 - baseX;
    } else {
      this.translateX = Math.min(-baseX, Math.max(vpW - layerW - baseX, this.translateX));
    }

    if (layerH <= vpH) {
      this.translateY = (vpH - layerH) / 2 - baseY;
    } else {
      this.translateY = Math.min(-baseY, Math.max(vpH - layerH - baseY, this.translateY));
    }
  }

  applyTransform() {
    this.layer.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
    if (this.zoomBadge) {
      this.zoomBadge.textContent = `${Math.round(this.scale * 100)}%`;
    }
  }

  onPointerDown(e) {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.viewport.setPointerCapture(e.pointerId); } catch (_) {}

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.pinchStartScale = this.scale;
      this.hasMoved = true; // pinça nunca conta como toque
      return;
    }

    this.hasMoved = false;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.initialTx = this.translateX;
    this.initialTy = this.translateY;
  }

  onPointerMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchStartDist > 0) {
        const rect = this.viewport.getBoundingClientRect();
        this.zoom(dist / this.pinchStartDist, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, this.pinchStartScale);
      }
      return;
    }

    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;

    if (Math.hypot(dx, dy) > 6) {
      this.hasMoved = true;
    }

    if (this.hasMoved) {
      this.translateX = this.initialTx + dx;
      this.translateY = this.initialTy + dy;
      this.clampPan();
      this.applyTransform();
    }
  }

  onPointerUp(e, cancelled = false) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    try { this.viewport.releasePointerCapture(e.pointerId); } catch (_) {}

    if (this.pointers.size === 1) {
      // Saiu da pinça: o dedo restante continua arrastando a partir daqui
      const [p] = [...this.pointers.values()];
      this.startX = p.x;
      this.startY = p.y;
      this.initialTx = this.translateX;
      this.initialTy = this.translateY;
      return;
    }

    if (this.pointers.size === 0 && !this.hasMoved && !cancelled) {
      this.handleTap(e.clientX, e.clientY);
    }
  }

  handleTap(clientX, clientY) {
    const layerRect = this.layer.getBoundingClientRect();
    if (!layerRect.width || !layerRect.height) return;
    const clickX = clientX - layerRect.left;
    const clickY = clientY - layerRect.top;

    // Toque fora da foto (nas faixas laterais) não marca nada
    if (clickX < 0 || clickY < 0 || clickX > layerRect.width || clickY > layerRect.height) return;

    const normX = clickX / layerRect.width;
    const normY = clickY / layerRect.height;

    this.selectedNormX = normX;
    this.selectedNormY = normY;

    this.pin.style.left = `${normX * 100}%`;
    this.pin.style.top = `${normY * 100}%`;
    this.pin.classList.remove('hidden');

    if (this.coordBadge) show(this.coordBadge, 'flex');

    if (navigator.vibrate) navigator.vibrate(35);

    if (this.onSelect) {
      this.onSelect(normX, normY);
    }
  }
}

// Elementos do Tabuleiro
const boardInput = document.getElementById('boardInput');
const boardInputReplace = document.getElementById('boardInputReplace');
const boardUploadLabel = document.getElementById('boardUploadLabel');
const boardPreview = document.getElementById('boardPreview');
const boardContainer = document.getElementById('boardContainer');

// Elementos da Caixa
const boxInput = document.getElementById('boxInput');
const boxInputReplace = document.getElementById('boxInputReplace');
const boxUploadLabel = document.getElementById('boxUploadLabel');
const boxPreview = document.getElementById('boxPreview');
const boxContainer = document.getElementById('boxContainer');

let boardPercentX = 0.5, boardPercentY = 0.5, hasSelectedBoard = false;
let targetPercentX = 0.5, targetPercentY = 0.5, hasSelectedBox = false;

// Instanciação dos visualizadores interativos
const boardViewer = new InteractiveImageViewer({
  viewport: document.getElementById('boardViewport'),
  layer: document.getElementById('boardTransformLayer'),
  img: boardPreview,
  pin: document.getElementById('boardPin'),
  zoomInBtn: document.getElementById('btnBoardZoomIn'),
  zoomOutBtn: document.getElementById('btnBoardZoomOut'),
  zoomResetBtn: document.getElementById('btnBoardZoomReset'),
  zoomBadge: document.getElementById('boardZoomBadge'),
  coordBadge: document.getElementById('boardCoordBadge'),
  onSelect: (nx, ny) => {
    boardPercentX = nx;
    boardPercentY = ny;
    hasSelectedBoard = true;
    checkReady();
  }
});

const boxViewer = new InteractiveImageViewer({
  viewport: document.getElementById('boxViewport'),
  layer: document.getElementById('boxTransformLayer'),
  img: boxPreview,
  pin: document.getElementById('targetPin'),
  zoomInBtn: document.getElementById('btnBoxZoomIn'),
  zoomOutBtn: document.getElementById('btnBoxZoomOut'),
  zoomResetBtn: document.getElementById('btnBoxZoomReset'),
  zoomBadge: document.getElementById('boxZoomBadge'),
  coordBadge: document.getElementById('boxCoordBadge'),
  onSelect: (nx, ny) => {
    targetPercentX = nx;
    targetPercentY = ny;
    hasSelectedBox = true;
    checkReady();
  }
});

const tableInput = document.getElementById('tableInput');
const tableInputText = document.getElementById('tableInputText');
const tablePreview = document.getElementById('tablePreview');
const tableContainer = document.getElementById('tableContainer');
const tablePlaceholder = document.getElementById('tablePlaceholder');

const btnFind = document.getElementById('btnFind');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loadingText');
const loadingSubtext = document.getElementById('loadingSubtext');
const resultSection = document.getElementById('resultSection');
const resultTitle = document.getElementById('resultTitle');
const resultSubtitle = document.getElementById('resultSubtitle');
const slotRoiContainer = document.getElementById('slotRoiContainer');
const slotRoiImg = document.getElementById('slotRoiImg');
const shapeMatchTag = document.getElementById('shapeMatchTag');
const checkTarget = document.getElementById('checkTarget');
const checkTable = document.getElementById('checkTable');

let boardBlob = null;
let boxBlob = null;
let tableBlob = null;
let lastFoundResult = null;

async function compressImage(file, maxDimension = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let width = img.naturalWidth;
      let height = img.naturalHeight;

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

      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Falha ao comprimir a imagem.')), 'image/jpeg', 0.85);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Formato de imagem não suportado.'));
    };
    img.src = url;
  });
}

// Lê o arquivo escolhido em um <input type="file"> e o devolve comprimido (ou null)
async function readPickedImage(input) {
  const file = input.files && input.files[0];
  input.value = ''; // permite escolher o mesmo arquivo de novo
  if (!file) return null;
  try {
    return await compressImage(file);
  } catch (err) {
    notify(err.message, 'error');
    return null;
  }
}

function loadBoardImage(blob) {
  boardBlob = blob;
  hasSelectedBoard = false;
  boardViewer.clearSelection();
  boardPreview.onload = () => boardViewer.reset();
  setObjectUrl(boardPreview, blob);
  hide(boardUploadLabel, 'flex');
  show(boardContainer, 'flex');
  checkReady();
}

function loadBoxImage(blob) {
  boxBlob = blob;
  hasSelectedBox = false;
  boxViewer.clearSelection();
  boxPreview.onload = () => boxViewer.reset();
  setObjectUrl(boxPreview, blob);
  hide(boxUploadLabel, 'flex');
  show(boxContainer, 'flex');
  checkReady();
}

function clearBoxImage() {
  boxBlob = null;
  hasSelectedBox = false;
  boxViewer.clearSelection();
  if (boxPreview.dataset.objectUrl) URL.revokeObjectURL(boxPreview.dataset.objectUrl);
  delete boxPreview.dataset.objectUrl;
  boxPreview.removeAttribute('src');
  hide(boxContainer, 'flex');
  show(boxUploadLabel, 'flex');
  checkReady();
}

// Carregar Tabuleiro
for (const input of [boardInput, boardInputReplace]) {
  input.addEventListener('change', async () => {
    const blob = await readPickedImage(input);
    if (blob) loadBoardImage(blob);
  });
}

// Carregar Imagem da Caixa (Manual)
for (const input of [boxInput, boxInputReplace]) {
  input.addEventListener('change', async () => {
    const blob = await readPickedImage(input);
    if (!blob) return;
    hide(boxSavedBadge);
    loadBoxImage(blob);
  });
}

// Peças Soltas na Mesa
tableInput.addEventListener('change', async () => {
  const blob = await readPickedImage(tableInput);
  if (!blob) return;
  tableBlob = blob;
  setObjectUrl(tablePreview, blob);
  show(tableContainer, 'flex');
  hide(tablePlaceholder, 'md:flex');
  tableInputText.textContent = 'Trocar foto';
  checkReady();
});

function hasTarget() {
  return Boolean((boardBlob && hasSelectedBoard) || (boxBlob && hasSelectedBox));
}

function setChecklistItem(li, done) {
  li.classList.toggle('text-slate-400', !done);
  li.classList.toggle('text-emerald-300', done);
  li.querySelector('use').setAttribute('href', done ? '#i-circle-check' : '#i-circle');
}

function checkReady() {
  const target = hasTarget();
  setChecklistItem(checkTarget, target);
  setChecklistItem(checkTable, Boolean(tableBlob));
  btnFind.disabled = !(target && tableBlob);
}

// Monta a requisição com o que o usuário marcou (só envia o que tem marcação)
function buildFindPieceForm(tableFileBlob, { annotate = true } = {}) {
  const formData = new FormData();
  formData.append('table_file', tableFileBlob, 'table.jpg');

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

  if (currentPuzzle && currentPuzzle.total_pieces) {
    formData.append('total_pieces', currentPuzzle.total_pieces);
  }

  formData.append('annotate', annotate ? 'true' : 'false');
  return formData;
}

// Enviar Foto Manual para API
btnFind.addEventListener('click', async () => {
  if (!tableBlob || !hasTarget()) return;

  btnFind.disabled = true;
  show(loading, 'flex');
  hide(resultSection);
  hide(slotRoiContainer, 'flex');

  if (serviceStatus.api !== 'ok') {
    loadingText.textContent = 'Acordando o servidor…';
    loadingSubtext.textContent = 'Na primeira busca do dia isso pode levar até 1 minuto.';
  } else {
    loadingText.textContent = 'Comparando formatos e cores…';
    loadingSubtext.textContent = 'Isso leva alguns segundos.';
  }

  try {
    if (apiWakeup) await apiWakeup;
    const res = await fetchWithTimeout(`${getApiUrl()}/api/find-piece`, {
      method: 'POST',
      headers: await authHeaders(),
      body: buildFindPieceForm(tableBlob)
    }, 90000);

    if (!res.ok) {
      throw new Error(await apiErrorMessage(res, 'Não foi possível encontrar a peça correspondente.'));
    }

    const data = await res.json();
    lastFoundResult = data;
    setServiceStatus('api', 'ok', 'Online');
    hide(apiNotice, 'flex');

    document.getElementById('pieceCrop').src = `data:image/jpeg;base64,${data.piece_crop_base64}`;
    document.getElementById('highlightedTable').src = `data:image/jpeg;base64,${data.annotated_table_base64}`;
    document.getElementById('rotationTag').textContent = rotationLabel(data.rotation_deg);

    if (data.confident) {
      resultTitle.textContent = 'Peça encontrada';
      resultSubtitle.textContent = `Está circulada em verde entre as ${data.pieces_detected} peças da foto.`;
    } else {
      resultTitle.textContent = 'Melhor palpite';
      resultSubtitle.textContent = 'A semelhança ficou baixa: confira antes de encaixar. Marcar o ponto com mais precisão ou uma foto mais próxima ajuda.';
    }

    if (data.slot_roi_base64) {
      slotRoiImg.src = `data:image/jpeg;base64,${data.slot_roi_base64}`;
      shapeMatchTag.textContent = data.shape_similarity >= MIN_SHAPE_TO_SHOW
        ? `Formato ${data.shape_similarity}% compatível`
        : 'Contorno pouco nítido na foto; a busca se apoiou mais nas cores';
      show(slotRoiContainer, 'flex');
    }

    btnConfirmFound.disabled = false;
    btnConfirmFoundText.textContent = currentPuzzle ? 'Encaixei! Registrar' : 'Encaixei!';

    if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
    show(resultSection);
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'O servidor demorou demais para responder. Tente de novo em instantes.'
      : error.message;
    notify(message, 'error', 7000);
  } finally {
    hide(loading, 'flex');
    checkReady();
  }
});

// Registrar Peça Encontrada no Histórico do Supabase
btnConfirmFound.addEventListener('click', async () => {
  if (!currentPuzzle || !supabaseClient) {
    btnConfirmFound.disabled = true;
    btnConfirmFoundText.textContent = 'Boa!';
    notify('Selecione um quebra-cabeça para acompanhar o progresso.', 'info');
    return;
  }

  try {
    btnConfirmFound.disabled = true;
    btnConfirmFoundText.textContent = 'Salvando…';

    const { error } = await supabaseClient.from('found_pieces').insert([{
      puzzle_id: currentPuzzle.id,
      piece_number: currentFoundCount + 1,
      rotation_deg: lastFoundResult ? lastFoundResult.rotation_deg : 0,
      shape_similarity: lastFoundResult ? lastFoundResult.shape_similarity : null
    }]);

    if (error) throw error;

    currentFoundCount += 1;
    updateProgressBar();
    // Fica desabilitado até a próxima busca para não registrar a mesma peça duas vezes
    btnConfirmFoundText.textContent = 'Registrada';
    if (navigator.vibrate) navigator.vibrate(50);

  } catch (err) {
    notify(`Erro ao registrar peça: ${err.message}`, 'error');
    btnConfirmFoundText.textContent = 'Encaixei! Registrar';
    btnConfirmFound.disabled = false;
  }
});

// ==========================================
// 7. SCANNER DE CÂMERA EM TEMPO REAL (AR)
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

// Amostragem entre quadros: cada requisição só sai depois da anterior responder
const SCAN_INTERVAL_MS = 700;

let cameraStream = null;
let scanTimer = null;
let scanSession = 0;
let isLocked = false;
let currentFacingMode = 'environment'; // Traseira
let audioCtx = null;

function playSuccessChime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
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
  if (!hasTarget()) {
    notify('Primeiro marque o buraco no tabuleiro ou um ponto na imagem da caixa.', 'info');
    document.getElementById('step1Title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    notify('Este navegador não libera a câmera ao vivo. Use “Foto da mesa”.', 'error');
    return;
  }

  scannerModal.showModal();
  await startScannerCamera();
});

btnCloseScanner.addEventListener('click', () => scannerModal.close());

// Fechar pelo botão, pelo Esc ou pelo gesto de voltar sempre desliga a câmera
scannerModal.addEventListener('close', stopScannerCamera);

btnSwitchCamera.addEventListener('click', async () => {
  currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';
  stopScannerCamera();
  await startScannerCamera();
});

// App em segundo plano: pausa o envio de quadros (economiza bateria e dados)
document.addEventListener('visibilitychange', () => {
  if (!scannerModal.open || !cameraStream) return;
  if (document.hidden) {
    stopRealtimeLoop();
  } else {
    startRealtimeLoop();
  }
});

async function startScannerCamera() {
  try {
    scannerStatusText.textContent = 'Ligando a câmera…';
    setLocked(false);

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

    scannerStatusText.textContent = serviceStatus.api === 'ok'
      ? 'Mova a câmera devagar sobre as peças espalhadas…'
      : 'Acordando o servidor… a primeira análise pode demorar.';
    startRealtimeLoop();

  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    notify(denied
      ? 'Permissão da câmera negada. Libere nas configurações do navegador.'
      : `Não foi possível abrir a câmera: ${err.message}`, 'error', 7000);
    scannerModal.close();
  }
}

function stopRealtimeLoop() {
  scanSession += 1; // invalida respostas ainda em voo
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
}

function stopScannerCamera() {
  stopRealtimeLoop();
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  scannerVideo.srcObject = null;
  clearAROverlay();
  setLocked(false);
}

function startRealtimeLoop() {
  stopRealtimeLoop();
  const session = scanSession;

  const tick = async () => {
    if (session !== scanSession) return;
    if (scannerVideo.videoWidth) {
      await scanFrame(session);
    }
    if (session === scanSession) scanTimer = setTimeout(tick, SCAN_INTERVAL_MS);
  };
  tick();
}

async function scanFrame(session) {
  try {
    // 1. Captura o frame atual do vídeo em um canvas temporário
    const captureCanvas = document.createElement('canvas');
    const targetW = 960;
    const targetH = Math.round((scannerVideo.videoHeight * targetW) / scannerVideo.videoWidth);
    captureCanvas.width = targetW;
    captureCanvas.height = targetH;
    captureCanvas.getContext('2d').drawImage(scannerVideo, 0, 0, targetW, targetH);

    const frameBlob = await new Promise(res => captureCanvas.toBlob(res, 'image/jpeg', 0.8));
    if (!frameBlob) return;

    // 2. Envia só as coordenadas de volta (annotate=false): resposta leve a cada quadro
    const res = await fetchWithTimeout(`${getApiUrl()}/api/find-piece`, {
      method: 'POST',
      headers: await authHeaders(),
      body: buildFindPieceForm(frameBlob, { annotate: false })
    }, 60000);

    if (session !== scanSession) return;

    if (serviceStatus.api !== 'ok') {
      setServiceStatus('api', 'ok', 'Online');
      hide(apiNotice, 'flex');
    }

    if (res.ok) {
      const data = await res.json();
      if (session !== scanSession) return;
      renderARMatch(data, targetW, targetH);
    } else {
      clearAROverlay();
      setLocked(false);
      scannerStatusText.textContent = res.status === 404
        ? 'Nenhuma peça à vista. Aponte para a mesa com as peças espalhadas.'
        : res.status === 401
          ? 'Sua sessão expirou. Feche a câmera, saia e entre de novo.'
          : 'Rastreando… aproxime ou afaste a câmera devagar.';
    }

  } catch (e) {
    // Quadro ignorado silenciosamente para manter o streaming contínuo
    if (session === scanSession && e.name === 'AbortError') {
      scannerStatusText.textContent = 'O servidor está lento. Continuando a tentar…';
    }
  }
}

// O vídeo usa object-contain (o quadro inteiro aparece, então a peça circulada nunca fica fora da tela):
// calcula a escala e as faixas laterais para alinhar o quadro ao que aparece na tela
function frameToScreenTransform(frameW, frameH) {
  const viewW = scannerVideo.clientWidth;
  const viewH = scannerVideo.clientHeight;
  const scale = Math.min(viewW / frameW, viewH / frameH);
  return {
    viewW,
    viewH,
    scale,
    offsetX: (viewW - frameW * scale) / 2,
    offsetY: (viewH - frameH * scale) / 2,
  };
}

function setLocked(locked) {
  if (locked === isLocked) return;
  isLocked = locked;
  scannerLockAlert.classList.toggle('hidden', !locked);
}

function renderARMatch(data, frameW, frameH) {
  const overlay = scannerOverlay;
  const t = frameToScreenTransform(frameW, frameH);
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(t.viewW * dpr);
  overlay.height = Math.round(t.viewH * dpr);
  const ctx = overlay.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, t.viewW, t.viewH);

  const [, , bw, bh] = data.bbox;
  const [cx, cy] = data.centroid;

  const screenCx = cx * t.scale + t.offsetX;
  const screenCy = cy * t.scale + t.offsetY;
  const radius = Math.max(bw, bh) * t.scale * 0.8;

  const color = data.confident ? '#34d399' : 'rgba(251, 191, 36, 0.85)';

  // Círculo em volta da peça (verde = confiante, âmbar = só um palpite)
  ctx.beginPath();
  ctx.arc(screenCx, screenCy, radius, 0, 2 * Math.PI);
  ctx.lineWidth = data.confident ? 5 : 3;
  ctx.setLineDash(data.confident ? [] : [10, 8]);
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = data.confident ? 18 : 0;
  ctx.stroke();

  // Mira central
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(screenCx - 16, screenCy);
  ctx.lineTo(screenCx + 16, screenCy);
  ctx.moveTo(screenCx, screenCy - 16);
  ctx.lineTo(screenCx, screenCy + 16);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  if (!data.confident) {
    setLocked(false);
    scannerStatusText.textContent = 'Talvez seja a circulada em amarelo… chegue mais perto para confirmar.';
    return;
  }

  // Feedback auditivo e tátil só na transição para "travado" (não a cada quadro)
  if (!isLocked) {
    playSuccessChime();
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  }
  setLocked(true);

  let detailText = rotationLabel(data.rotation_deg);
  if (data.shape_similarity >= MIN_SHAPE_TO_SHOW) {
    detailText += ` · formato ${data.shape_similarity}% compatível`;
  }
  scannerLockDetails.textContent = detailText;
  scannerStatusText.textContent = 'Segure a câmera parada sobre a peça circulada.';
}

function clearAROverlay() {
  const ctx = scannerOverlay.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, scannerOverlay.width, scannerOverlay.height);
}

// ==========================================
// 8. INICIALIZAÇÃO
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
  checkReady();
  apiWakeup = checkApiHealth();
  initSupabase();
});
