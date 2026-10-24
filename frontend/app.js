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
const newPuzzleCols = document.getElementById('newPuzzleCols');
const newPuzzleRows = document.getElementById('newPuzzleRows');
const newPuzzleWidth = document.getElementById('newPuzzleWidth');
const newPuzzleHeight = document.getElementById('newPuzzleHeight');
const newPuzzleTotalText = document.getElementById('newPuzzleTotalText');
const newPuzzleBoxLabel = document.getElementById('newPuzzleBoxLabel');
const newPuzzleTitle = document.getElementById('newPuzzleTitle');
const btnEditPuzzle = document.getElementById('btnEditPuzzle');
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
  exitGridMode();
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

// Formulário serve para cadastrar e para editar (ex.: incluir a grade num quebra-cabeça antigo)
let editingPuzzle = null;

function openPuzzleForm(puzzle = null) {
  if (!supabaseClient || !currentUser) {
    notify('Banco de dados desconectado. Confira em Configurações.', 'error');
    return;
  }
  editingPuzzle = puzzle;
  newPuzzleForm.reset();
  newPuzzleTitle.textContent = puzzle ? 'Editar quebra-cabeça' : 'Novo quebra-cabeça';
  newPuzzleBoxFile.required = !puzzle;
  newPuzzleBoxLabel.textContent = puzzle
    ? 'Trocar a foto da arte (opcional)'
    : 'Foto da arte (caixa ou pôster), de frente e bem nítida';
  btnCreatePuzzleSubmit.textContent = puzzle ? 'Salvar alterações' : 'Salvar quebra-cabeça';
  if (puzzle) {
    newPuzzleName.value = puzzle.name || '';
    newPuzzleCols.value = puzzle.cols || '';
    newPuzzleRows.value = puzzle.rows || '';
    newPuzzleWidth.value = puzzle.width_cm || '';
    newPuzzleHeight.value = puzzle.height_cm || '';
  }
  updateTotalText();
  newPuzzleModal.showModal();
  newPuzzleName.focus();
}

function updateTotalText() {
  const c = parseInt(newPuzzleCols.value, 10), r = parseInt(newPuzzleRows.value, 10);
  newPuzzleTotalText.textContent = (c > 1 && r > 1)
    ? `${c} × ${r} = ${c * r} peças. As medidas deixam o mapa mais preciso.`
    : 'Colunas × linhas = total de peças. As medidas deixam o mapa mais preciso.';
}
newPuzzleCols.addEventListener('input', updateTotalText);
newPuzzleRows.addEventListener('input', updateTotalText);

btnNewPuzzle.addEventListener('click', () => openPuzzleForm(null));
btnEditPuzzle.addEventListener('click', () => { if (currentPuzzle) openPuzzleForm(currentPuzzle); });
btnCloseNewPuzzleModal.addEventListener('click', () => newPuzzleModal.close());

newPuzzleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = newPuzzleName.value.trim();
  const cols = parseInt(newPuzzleCols.value, 10);
  const rows = parseInt(newPuzzleRows.value, 10);
  const width = parseFloat(newPuzzleWidth.value);
  const height = parseFloat(newPuzzleHeight.value);
  const file = newPuzzleBoxFile.files[0];

  if (!name || !(cols > 1) || !(rows > 1) || (!editingPuzzle && !file)) {
    newPuzzleForm.reportValidity();
    return;
  }

  btnCreatePuzzleSubmit.disabled = true;
  btnCreatePuzzleSubmit.textContent = file ? 'Enviando imagem…' : 'Salvando…';

  try {
    const row = {
      name, cols, rows,
      total_pieces: cols * rows,
      width_cm: width > 0 ? width : null,
      height_cm: height > 0 ? height : null,
    };

    if (file) {
      // A arte precisa de detalhe: cada peça ocupa poucos pixels na foto da caixa
      const compressedBlob = await compressImage(file, 2400, 0.9);
      // Bucket privado: cada usuário grava na própria pasta
      const filePath = `${currentUser.id}/box_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
      const { error: uploadError } = await supabaseClient.storage
        .from('puzzle-images')
        .upload(filePath, compressedBlob, { contentType: 'image/jpeg' });
      if (uploadError) throw uploadError;
      row.box_image_path = filePath;
      row.box_corners = null; // foto nova: os cantos precisam ser marcados de novo
    }

    const query = editingPuzzle
      ? supabaseClient.from('puzzles').update(row).eq('id', editingPuzzle.id)
      : supabaseClient.from('puzzles').insert([row]);
    const { data: saved, error } = await query.select().single();
    if (error) throw error;

    notify(editingPuzzle ? 'Alterações salvas.' : `“${name}” cadastrado.`, 'success');
    newPuzzleModal.close();
    newPuzzleForm.reset();
    await loadPuzzlesFromSupabase(saved.id);

  } catch (err) {
    const msg = /column|schema cache/i.test(err.message || '')
      ? 'O banco ainda não tem os campos da grade. Rode a migração do mapa no Supabase.'
      : `Não foi possível salvar: ${err.message}`;
    notify(msg, 'error', 8000);
  } finally {
    btnCreatePuzzleSubmit.disabled = false;
    btnCreatePuzzleSubmit.textContent = editingPuzzle ? 'Salvar alterações' : 'Salvar quebra-cabeça';
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
      opt.textContent = (p.cols && p.rows)
        ? `${p.name} · ${p.cols}×${p.rows} (${p.cols * p.rows} peças)`
        : `${p.name} · ${p.total_pieces} peças`;
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
    exitGridMode();
    clearBoxImage();
    return;
  }
  onPuzzleSelected(selected);
});

async function onPuzzleSelected(puzzle) {
  currentPuzzle = puzzle;
  exitGridMode();
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
    if (isGridPuzzle(puzzle)) {
      await enterGridMode(puzzle, imageResult.value);
    } else {
      loadBoxImage(imageResult.value);
      show(boxSavedBadge);
    }
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
  const total = isGridPuzzle(currentPuzzle) ? currentPuzzle.cols * currentPuzzle.rows : (currentPuzzle.total_pieces || 1000);
  // Com mapa escaneado, o progresso vem do mapa (montadas de verdade), não só das registradas no app
  const done = grid.scanMap ? countPlaced(grid.scanMap) : currentFoundCount;
  const percent = Math.min(100, Math.round((done / total) * 100));
  puzzleProgressStats.textContent = `${done} / ${total} peças · ${percent}%`;
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

// Elementos da Caixa
const boxInput = document.getElementById('boxInput');
const boxInputReplace = document.getElementById('boxInputReplace');
const boxUploadLabel = document.getElementById('boxUploadLabel');
const boxPreview = document.getElementById('boxPreview');
const boxContainer = document.getElementById('boxContainer');

let targetPercentX = 0.5, targetPercentY = 0.5, hasSelectedBox = false;

// Instanciação dos visualizadores interativos
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
const tableInputGallery = document.getElementById('tableInputGallery');
const tableInputText = document.getElementById('tableInputText');
const tableContainer = document.getElementById('tableContainer');
const tablePlaceholder = document.getElementById('tablePlaceholder');
const tablePhotosList = document.getElementById('tablePhotosList');
const tablePhotosCount = document.getElementById('tablePhotosCount');
const btnClearTablePhotos = document.getElementById('btnClearTablePhotos');
const btnFindText = document.getElementById('btnFindText');
const resultPhotoTabs = document.getElementById('resultPhotoTabs');
const paperNotice = document.getElementById('paperNotice');

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

let boxBlob = null;
// Fotos das peças (uma folha A4 por foto): [{ blob, url }]
const tablePhotos = [];
// Mesmo limite do servidor
const MAX_TABLE_PHOTOS = 8;
let lastFoundResult = null;

async function compressImage(file, maxDimension = 1600, quality = 0.85) {
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

      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Falha ao comprimir a imagem.')), 'image/jpeg', quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Formato de imagem não suportado.'));
    };
    img.src = url;
  });
}

// Lê o arquivo escolhido em um <input type="file"> e o devolve comprimido (ou null)
async function readPickedImage(input, maxDimension = 1600, quality = 0.85) {
  const file = input.files && input.files[0];
  input.value = ''; // permite escolher o mesmo arquivo de novo
  if (!file) return null;
  try {
    return await compressImage(file, maxDimension, quality);
  } catch (err) {
    notify(err.message, 'error');
    return null;
  }
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

// Carregar Imagem da Caixa (Manual)
for (const input of [boxInput, boxInputReplace]) {
  input.addEventListener('change', async () => {
    const blob = await readPickedImage(input);
    if (!blob) return;
    hide(boxSavedBadge);
    loadBoxImage(blob);
  });
}

// Fotos das peças (câmera: uma por vez; galeria: várias de uma vez), até MAX_TABLE_PHOTOS
for (const input of [tableInput, tableInputGallery]) {
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.value = ''; // permite escolher o mesmo arquivo de novo
    const room = MAX_TABLE_PHOTOS - tablePhotos.length;
    if (files.length > room) {
      notify(room > 0 ? `Dá para anexar até ${MAX_TABLE_PHOTOS} fotos: entraram só as ${room} primeiras.` : `Já são ${MAX_TABLE_PHOTOS} fotos. Remova alguma para anexar outra.`, 'info');
    }
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        const blob = await compressImage(file, TABLE_MAX_SIDE, 0.9);
        tablePhotos.push({ blob, url: URL.createObjectURL(blob) });
      } catch (err) {
        notify(err.message, 'error');
      }
    }
    renderTablePhotos();
  });
}

btnClearTablePhotos.addEventListener('click', () => {
  tablePhotos.splice(0).forEach(p => URL.revokeObjectURL(p.url));
  renderTablePhotos();
});

function renderTablePhotos() {
  tablePhotosList.innerHTML = '';
  tablePhotos.forEach((photo, i) => {
    const li = document.createElement('li');
    li.className = 'relative aspect-[3/4] rounded-lg overflow-hidden ring-1 ring-inset ring-slate-700 bg-slate-950';
    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = `Foto ${i + 1} das peças`;
    img.className = 'w-full h-full object-cover';
    const tag = document.createElement('span');
    tag.className = 'absolute left-1 top-1 px-1.5 rounded bg-black/70 text-[11px] font-bold text-slate-100';
    tag.textContent = String(i + 1);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'absolute right-1 top-1 w-8 h-8 rounded-full bg-black/70 hover:bg-black text-slate-100 flex items-center justify-center';
    del.setAttribute('aria-label', `Remover a foto ${i + 1}`);
    del.innerHTML = '<svg class="icon w-4 h-4"><use href="#i-x"/></svg>';
    del.addEventListener('click', () => {
      URL.revokeObjectURL(photo.url);
      tablePhotos.splice(i, 1);
      renderTablePhotos();
    });
    li.append(img, tag, del);
    tablePhotosList.appendChild(li);
  });
  const n = tablePhotos.length;
  tablePhotosCount.textContent = n === 1 ? '1 foto' : `${n} fotos`;
  if (n) {
    show(tableContainer, 'flex');
    hide(tablePlaceholder, 'md:flex');
  } else {
    hide(tableContainer, 'flex');
    show(tablePlaceholder, 'md:flex');
  }
  tableInputText.textContent = n ? 'Mais uma foto' : 'Tirar foto';
  btnFindText.textContent = n > 1 ? `Procurar nas ${n} fotos` : 'Procurar nas fotos';
  checkReady();
  Workspace.onPhotosChanged();
}

// Lado máximo da foto da mesa: com centenas de peças, cada uma precisa de pixels suficientes
const TABLE_MAX_SIDE = 3000;

function hasTarget() {
  return gridActive() ? Boolean(grid.cell) : Boolean(boxBlob && hasSelectedBox);
}

function setChecklistItem(li, done) {
  li.classList.toggle('text-slate-400', !done);
  li.classList.toggle('text-emerald-300', done);
  li.querySelector('use').setAttribute('href', done ? '#i-circle-check' : '#i-circle');
}

function checkReady() {
  const target = hasTarget();
  setChecklistItem(checkTarget, target);
  setChecklistItem(checkTable, tablePhotos.length > 0);
  btnFind.disabled = !(target && tablePhotos.length);
}

// Monta a requisição com o que o usuário marcou (só envia o que tem marcação)
function appendTablePhotos(formData, blobs) {
  blobs.forEach((b, i) => formData.append('table_files', b, `pecas-${i + 1}.jpg`));
}

function buildFindPieceForm(tableBlobs, { annotate = true } = {}) {
  const formData = new FormData();
  appendTablePhotos(formData, tableBlobs);

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

// Tabuleiro endireitado em volta da célula escolhida (3 × 3 células), se ela está vazia no último
// escaneamento desta sessão: as abas e encaixes das vizinhas mostram o formato da peça que falta
async function holeBlob() {
  if (!grid.board || !grid.cell || cellState(grid.cell) !== '0') return null;
  const { col, row } = grid.cell;
  const key = `${col},${row}`;
  if (grid.hole && grid.hole.key === key) return grid.hole.blob;
  const p = currentPuzzle;
  const { img, corners } = grid.board;
  const cellH = Math.round(HOLE_CELL_PX * Grid.cellAspect(p, img, corners));
  const win = Grid.rectify(img, Grid.windowCorners(corners, p.cols, p.rows, col, row, 1), { cols: 3, rows: 3, cellW: HOLE_CELL_PX, cellH });
  const blob = await Grid.canvasToBlob(win, 0.9);
  grid.hole = { key, blob };
  return blob;
}

// Requisição da busca por célula do mapa
async function buildFindCellForm(tableBlobs, { annotate = true } = {}) {
  const formData = new FormData();
  appendTablePhotos(formData, tableBlobs);
  formData.append('box_file', grid.artBlob, 'art.jpg');
  formData.append('cols', currentPuzzle.cols);
  formData.append('rows', currentPuzzle.rows);
  formData.append('col', grid.cell.col);
  formData.append('row', grid.cell.row);
  formData.append('top_k', '5');
  formData.append('annotate', annotate ? 'true' : 'false');
  // Largura de uma peça: com a folha A4 na foto, o servidor sabe o tamanho exato de cada peça
  if (currentPuzzle.width_cm > 0) formData.append('piece_mm', String((currentPuzzle.width_cm * 10) / currentPuzzle.cols));
  // As peças soltas são as que faltam: as cores dessas células da arte calibram as cores das fotos
  if (grid.scanMap) formData.append('scan_map', grid.scanMap);
  try {
    const hole = await holeBlob();
    if (hole) formData.append('hole_file', hole, 'hole.jpg');
  } catch (_) { /* sem o buraco a busca segue só pela arte */ }
  return formData;
}

// "em cima aba, à direita encaixe…" com os lados do buraco que a busca conseguiu medir
const HOLE_SIDE_NAMES = { top: 'em cima', right: 'à direita', bottom: 'embaixo', left: 'à esquerda' };
const HOLE_KIND_NAMES = { tab: 'aba', blank: 'encaixe', flat: 'reto' };
function holeLabel(hole) {
  if (!hole) return '';
  const parts = Object.keys(HOLE_SIDE_NAMES).filter(s => hole[s]).map(s => `${HOLE_SIDE_NAMES[s]} ${HOLE_KIND_NAMES[hole[s]]}`);
  return parts.length ? `Formato do buraco considerado: ${parts.join(', ')}.` : '';
}

// Lista numerada dos candidatos (mesma numeração dos círculos na foto)
function renderCandidates(data) {
  candidateList.innerHTML = '';
  data.candidates.forEach((c) => {
    const li = document.createElement('li');
    li.className = 'p-3 rounded-xl bg-slate-950 ring-1 ring-inset ring-slate-800 flex items-center gap-3';
    const badge = document.createElement('span');
    badge.className = `w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-sm font-extrabold ${c.rank === 1 ? (data.confident ? 'bg-emerald-400 text-slate-950' : 'bg-amber-400 text-slate-950') : 'bg-slate-700 text-slate-100'}`;
    badge.textContent = String(c.rank);
    const text = document.createElement('div');
    text.className = 'min-w-0';
    const line1 = document.createElement('p');
    line1.className = 'text-sm font-semibold';
    line1.textContent = rotationLabel(c.rotation_deg) + (tablePhotos.length > 1 && c.photo != null ? ` · foto ${c.photo + 1}` : '');
    const line2 = document.createElement('p');
    line2.className = 'text-xs text-slate-400';
    line2.textContent = `Semelhança ${Math.round(c.score)}%${c.edge_ok ? '' : ' · formato de borda não bate'}${c.shape_ok === false ? ' · abas/encaixes não batem com o buraco' : ''}`;
    text.append(line1, line2);
    li.append(badge, text);
    candidateList.appendChild(li);
  });
  show(candidateList);
}

// Foto(s) com as candidatas circuladas: com várias fotos, uma aba para cada foto que tem candidatas
function renderResultPhotos(data) {
  const highlighted = document.getElementById('highlightedTable');
  const images = data.annotated_tables || [{ photo: data.photo || 0, image_base64: data.annotated_table_base64 }];
  const multi = (data.photos || []).length > 1;
  const showPhoto = (photo) => {
    const im = images.find(x => x.photo === photo) || images[0];
    highlighted.src = `data:image/jpeg;base64,${im.image_base64}`;
    resultPhotoTabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(Number(b.dataset.photo) === im.photo)));
  };
  resultPhotoTabs.innerHTML = '';
  if (multi && images.length > 1) {
    images.forEach((im) => {
      const n = (data.candidates || []).filter(c => c.photo === im.photo).map(c => c.rank);
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.photo = String(im.photo);
      b.className = 'h-9 px-3 rounded-lg bg-slate-950 ring-1 ring-inset ring-slate-700 text-xs font-semibold text-slate-200 aria-selected:ring-2 aria-selected:ring-emerald-400';
      b.textContent = `Foto ${im.photo + 1}${n.length ? ` · nº ${n.join(', ')}` : ''}`;
      b.addEventListener('click', () => showPhoto(im.photo));
      resultPhotoTabs.appendChild(b);
    });
    show(resultPhotoTabs, 'flex');
  } else {
    hide(resultPhotoTabs, 'flex');
  }
  const best = data.candidates ? data.candidates[0].photo : (data.photo || 0);
  showPhoto(best);
  // Fotos sem fundo branco (nem folha nem mesa clara): a busca seguiu, mas sem corrigir a cor da luz
  const noWhite = (data.photos || []).map((p, i) => (p.white_ref === false ? i + 1 : null)).filter(Boolean);
  if (noWhite.length) {
    paperNotice.textContent = (data.photos.length > 1 ? `Não achei fundo branco na foto ${noWhite.join(', ')}.` : 'Não achei fundo branco na foto.')
      + ' A busca seguiu, mas sobre uma folha branca a cor das peças fica bem mais precisa.';
    show(paperNotice);
  } else {
    hide(paperNotice);
  }
}

// Enviar Foto Manual para API
btnFind.addEventListener('click', async () => {
  if (!tablePhotos.length || !hasTarget()) return;

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
    const byCell = gridActive();
    const res = await fetchWithTimeout(`${getApiUrl()}/api/${byCell ? 'find-cell' : 'find-piece'}`, {
      method: 'POST',
      headers: await authHeaders(),
      body: byCell ? await buildFindCellForm(tablePhotos.map(p => p.blob)) : buildFindPieceForm(tablePhotos.map(p => p.blob))
    }, 120000);

    if (!res.ok) {
      throw new Error(await apiErrorMessage(res, 'Não foi possível encontrar a peça correspondente.'));
    }

    const data = await res.json();
    setServiceStatus('api', 'ok', 'Online');
    hide(apiNotice, 'flex');

    // Mapa: as candidatas abrem direto na tela de comparar e confirmar
    if (byCell) {
      Workspace.openFindResults(data, { ...grid.cell });
      if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
      return;
    }

    document.getElementById('pieceCrop').src = `data:image/jpeg;base64,${data.piece_crop_base64}`;
    renderResultPhotos(data);
    hide(candidateList);

    if (byCell) {
      const best = data.candidates[0];
      lastFoundResult = { rotation_deg: best.rotation_deg, shape_similarity: null, cell: { ...grid.cell } };
      document.getElementById('rotationTag').textContent = rotationLabel(best.rotation_deg);
      renderCandidates(data);
      const n = Grid.cellNumber(grid.cell.col, grid.cell.row, currentPuzzle.cols);
      if (data.confident) {
        resultTitle.textContent = `Peça nº ${n} encontrada`;
        resultSubtitle.textContent = 'É a nº 1, circulada em verde. As outras numeradas são as próximas mais parecidas.';
      } else {
        resultTitle.textContent = `Candidatas para a peça nº ${n}`;
        resultSubtitle.textContent = 'Confira as numeradas na foto, começando pela nº 1.';
      }
      const holeText = holeLabel(data.hole);
      if (holeText) resultSubtitle.textContent += ` ${holeText}`;
    } else if (data.confident) {
      resultTitle.textContent = 'Peça encontrada';
      resultSubtitle.textContent = `Está circulada em verde entre as ${data.pieces_detected} peças da foto.`;
    }
    if (!byCell) {
      lastFoundResult = data;
      document.getElementById('rotationTag').textContent = rotationLabel(data.rotation_deg);
    }
    if (!byCell && !data.confident) {
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

// Registra a peça encontrada no histórico (e, no mapa, marca a célula como montada)
async function registerFound({ cell = null, rotation = 0, shapeSimilarity = null } = {}) {
  const record = {
    puzzle_id: currentPuzzle.id,
    piece_number: currentFoundCount + 1,
    rotation_deg: rotation || 0,
    shape_similarity: shapeSimilarity,
  };
  if (cell) record.cell_index = cell.row * currentPuzzle.cols + cell.col;
  const { error } = await supabaseClient.from('found_pieces').insert([record]);
  if (error) throw error;
  if (cell && gridActive()) await setCellState(cell, '1');
  currentFoundCount += 1;
  updateProgressBar();
  if (navigator.vibrate) navigator.vibrate(50);
}

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
    await registerFound({
      cell: lastFoundResult && lastFoundResult.cell,
      rotation: lastFoundResult ? lastFoundResult.rotation_deg : 0,
      shapeSimilarity: lastFoundResult ? lastFoundResult.shape_similarity : null,
    });
    // Fica desabilitado até a próxima busca para não registrar a mesma peça duas vezes
    btnConfirmFoundText.textContent = 'Registrada';
  } catch (err) {
    notify(`Erro ao registrar peça: ${err.message}`, 'error');
    btnConfirmFoundText.textContent = 'Encaixei! Registrar';
    btnConfirmFound.disabled = false;
  }
});

// ==========================================
// 7. MAPA POR GRADE (colunas × linhas)
// ==========================================
const gridCard = document.getElementById('gridCard');
const gridCounts = document.getElementById('gridCounts');
const gridSetup = document.getElementById('gridSetup');
const btnSetCorners = document.getElementById('btnSetCorners');
const btnEditCorners = document.getElementById('btnEditCorners');
const mapContainer = document.getElementById('mapContainer');
const mapImage = document.getElementById('mapImage');
const mapPin = document.getElementById('mapPin');
const cellNumber = document.getElementById('cellNumber');
const cellInfo = document.getElementById('cellInfo');
const btnToggleCell = document.getElementById('btnToggleCell');
const scanInput = document.getElementById('scanInput');
const scanInputGallery = document.getElementById('scanInputGallery');
const scanLoading = document.getElementById('scanLoading');
const scanLoadingText = document.getElementById('scanLoadingText');
const scanDetails = document.getElementById('scanDetails');
const scanOverlay = document.getElementById('scanOverlay');
const legacyTarget = document.getElementById('legacyTarget');
const candidateList = document.getElementById('candidateList');
const step1Text = document.getElementById('step1Text');
const step1Sub = document.getElementById('step1Sub');

// Margem (em células) de mesa em volta do tabuleiro retificado: ensina a cor do vazio
const SCAN_MARGIN = 0.6;

const grid = {
  boxBitmap: null,  // foto da caixa (canvas)
  art: null,        // arte retificada: exatamente cols × rows células
  artBlob: null,
  scanMap: null,    // '1' montada, '0' faltando, '?' desconhecida (linha por linha)
  cell: null,       // {col, row} escolhida
  board: null,      // última foto do tabuleiro escaneado {img, corners}: dá o formato dos buracos
  hole: null,       // recorte do buraco já gerado {key, blob}
};

// Lado (px) da célula no recorte do buraco enviado à busca
const HOLE_CELL_PX = 64;

const isGridPuzzle = (p) => Boolean(p && p.cols > 1 && p.rows > 1);
const gridActive = () => Boolean(currentPuzzle && isGridPuzzle(currentPuzzle) && grid.art && grid.artBlob);
const countPlaced = (map) => { let n = 0; for (let i = 0; i < map.length; i++) if (map[i] === '1') n++; return n; };

const mapViewer = new InteractiveImageViewer({
  viewport: document.getElementById('mapViewport'),
  layer: document.getElementById('mapTransformLayer'),
  img: mapImage,
  pin: mapPin,
  zoomInBtn: document.getElementById('btnMapZoomIn'),
  zoomOutBtn: document.getElementById('btnMapZoomOut'),
  zoomResetBtn: document.getElementById('btnMapZoomReset'),
  zoomBadge: document.getElementById('mapZoomBadge'),
  coordBadge: null,
  onSelect: (nx, ny) => {
    const { cols, rows } = currentPuzzle;
    const col = Math.min(cols - 1, Math.floor(nx * cols)), row = Math.min(rows - 1, Math.floor(ny * rows));
    if (!Workspace.onMapTap(col, row)) selectCell(col, row);
  }
});

function exitGridMode() {
  grid.boxBitmap = grid.art = grid.artBlob = grid.scanMap = grid.cell = grid.board = grid.hole = null;
  hide(gridCard);
  show(legacyTarget, 'grid');
  Workspace.onGridMode(false);
  hide(candidateList);
  step1Text.textContent = 'Escolha a peça que falta';
  step1Sub.textContent = 'tocando na imagem da caixa';
  checkReady();
}

async function enterGridMode(puzzle, boxImageBlob) {
  hide(legacyTarget, 'grid');
  show(gridCard);
  Workspace.onGridMode(true);
  step1Text.textContent = 'Escolha a peça que falta';
  step1Sub.textContent = 'no mapa ou pelo número';
  cellNumber.max = String(puzzle.cols * puzzle.rows);
  grid.scanMap = (puzzle.scan_map && puzzle.scan_map.length === puzzle.cols * puzzle.rows) ? puzzle.scan_map : null;
  grid.boxBitmap = await Grid.loadBitmap(boxImageBlob, 3000);
  if (currentPuzzle !== puzzle) return;
  updateGridCounts();
  Workspace.refresh({ autoOpen: true });
  if (Array.isArray(puzzle.box_corners) && puzzle.box_corners.length === 4) {
    await buildArt();
  } else {
    show(gridSetup);
    hide(mapContainer, 'flex');
  }
}

async function buildArt() {
  const p = currentPuzzle;
  const corners = p.box_corners;
  const native = Grid.nativeCell(grid.boxBitmap, corners, p.cols, p.rows);
  // Não inventa detalhe: no máximo 48 px por célula (o motor compara a ~64 px)
  const cellW = Math.max(20, Math.min(48, Math.round(native.w)));
  const cellH = Math.max(12, Math.round(cellW * Grid.cellAspect(p, grid.boxBitmap, corners)));
  grid.art = Grid.rectify(grid.boxBitmap, corners, { cols: p.cols, rows: p.rows, cellW, cellH });
  grid.artBlob = await Grid.canvasToBlob(grid.art, 0.92);
  hide(gridSetup);
  show(mapContainer, 'flex');
  await renderMapImage(true);
  if (grid.cell) selectCell(grid.cell.col, grid.cell.row);
  checkReady();
  Workspace.refresh({ autoOpen: true });
}

async function renderMapImage(resetZoom = false) {
  const p = currentPuzzle;
  const canvas = Grid.renderMap(grid.art, p.cols, p.rows, grid.scanMap);
  const blob = await Grid.canvasToBlob(canvas, 0.88);
  if (resetZoom) mapImage.onload = () => mapViewer.reset();
  else mapImage.onload = null;
  setObjectUrl(mapImage, blob);
}

function updateGridCounts() {
  const p = currentPuzzle;
  if (!p || !isGridPuzzle(p)) return;
  const total = p.cols * p.rows;
  if (grid.scanMap) {
    const placed = countPlaced(grid.scanMap);
    gridCounts.textContent = `${placed} montadas · ${total - placed} faltam`;
  } else {
    gridCounts.textContent = `${total} peças · não escaneado`;
  }
  updateProgressBar();
  Workspace.refresh();
}

function cellState(cell) {
  if (!grid.scanMap) return '?';
  return grid.scanMap[cell.row * currentPuzzle.cols + cell.col];
}

function selectCell(col, row) {
  const p = currentPuzzle;
  grid.cell = { col, row };
  const n = Grid.cellNumber(col, row, p.cols);
  if (String(cellNumber.value) !== String(n)) cellNumber.value = String(n);
  const state = cellState(grid.cell);
  const stateText = state === '1' ? ' · já montada' : state === '0' ? ' · faltando' : '';
  cellInfo.textContent = `Coluna ${col + 1} · Linha ${row + 1}${stateText}`;
  mapPin.style.left = `${((col + 0.5) / p.cols) * 100}%`;
  mapPin.style.top = `${((row + 0.5) / p.rows) * 100}%`;
  mapPin.classList.remove('hidden');
  btnToggleCell.textContent = state === '1' ? 'Marcar como faltando' : 'Marcar como montada';
  show(btnToggleCell);
  checkReady();
}

cellNumber.addEventListener('change', () => {
  const p = currentPuzzle;
  const n = parseInt(cellNumber.value, 10);
  if (!p || !isGridPuzzle(p) || !(n >= 1 && n <= p.cols * p.rows)) {
    if (cellNumber.value) notify(`Digite um número de 1 a ${p ? p.cols * p.rows : '…'}.`, 'info');
    return;
  }
  const { col, row } = Grid.cellFromNumber(n, p.cols);
  selectCell(col, row);
});

async function persistScanMap() {
  const { error } = await supabaseClient.from('puzzles')
    .update({ scan_map: grid.scanMap, scanned_at: new Date().toISOString() })
    .eq('id', currentPuzzle.id);
  if (error) throw error;
  currentPuzzle.scan_map = grid.scanMap;
}

async function setCellState(cell, value) {
  const p = currentPuzzle;
  const total = p.cols * p.rows;
  const map = (grid.scanMap || '?'.repeat(total)).split('');
  map[cell.row * p.cols + cell.col] = value;
  grid.scanMap = map.join('');
  updateGridCounts();
  await renderMapImage();
  if (grid.cell && grid.cell.col === cell.col && grid.cell.row === cell.row) selectCell(cell.col, cell.row);
  try {
    await persistScanMap();
  } catch (err) {
    notify(`Mapa atualizado só neste aparelho: ${err.message}`, 'error');
  }
}

btnToggleCell.addEventListener('click', () => {
  if (!grid.cell) return;
  setCellState(grid.cell, cellState(grid.cell) === '1' ? '0' : '1');
});

async function editBoxCorners() {
  const p = currentPuzzle;
  const res = await Grid.editCorners({
    img: grid.boxBitmap,
    title: 'Cantos da arte',
    hint: 'Arraste as 4 bolinhas até os cantos da arte. A amarela (nº 1) é o canto superior esquerdo; use Girar se a foto estiver de lado. A grade verde deve cair sobre as peças.',
    corners: p.box_corners,
    cols: p.cols,
    rows: p.rows,
  });
  if (!res) return;
  const corners = res.corners.map(([x, y]) => [Number(x.toFixed(5)), Number(y.toFixed(5))]);
  try {
    const { error } = await supabaseClient.from('puzzles').update({ box_corners: corners }).eq('id', p.id);
    if (error) throw error;
  } catch (err) {
    notify(/column|schema cache/i.test(err.message || '')
      ? 'O banco ainda não tem os campos da grade. Rode a migração do mapa no Supabase.'
      : `Cantos usados só neste aparelho: ${err.message}`, 'error', 8000);
  }
  p.box_corners = corners;
  await buildArt();
}
btnSetCorners.addEventListener('click', editBoxCorners);
btnEditCorners.addEventListener('click', editBoxCorners);

// Escanear o tabuleiro: foto → cantos (+ área vazia) → retifica → API → mapa
for (const input of [scanInput, scanInputGallery]) {
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file || !gridActive()) {
      if (file) notify('Marque primeiro os cantos da arte para criar o mapa.', 'info');
      return;
    }
    const p = currentPuzzle;
    let img;
    try {
      img = await Grid.loadBitmap(file, 3000);
    } catch (err) {
      notify(err.message, 'error');
      return;
    }
    const savedKey = `pf_board_corners_${p.id}`;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(savedKey) || 'null'); } catch (_) {}
    const res = await Grid.editCorners({
      img,
      title: 'Cantos do tabuleiro',
      hint: 'Arraste até os 4 cantos do quebra-cabeça (ou onde eles ficam). A amarela (nº 1) é o canto superior esquerdo da ARTE; use Girar se a foto estiver de lado.',
      corners: saved,
      cols: p.cols,
      rows: p.rows,
      askMat: true,
    });
    if (!res) return;
    try { localStorage.setItem(savedKey, JSON.stringify(res.corners)); } catch (_) {}

    show(scanLoading, 'flex');
    scanLoadingText.textContent = serviceStatus.api === 'ok' ? 'Analisando o tabuleiro…' : 'Acordando o servidor… pode levar até 1 minuto.';
    try {
      const native = Grid.nativeCell(img, res.corners, p.cols, p.rows);
      const cellW = Math.max(20, Math.min(40, Math.round(native.w)));
      const cellH = Math.max(12, Math.round(cellW * Grid.cellAspect(p, img, res.corners)));
      const board = Grid.rectify(img, res.corners, { cols: p.cols, rows: p.rows, cellW, cellH, margin: SCAN_MARGIN });
      const boardBlob = await Grid.canvasToBlob(board, 0.9);

      const form = new FormData();
      form.append('box_file', grid.artBlob, 'art.jpg');
      form.append('board_file', boardBlob, 'board.jpg');
      form.append('cols', p.cols);
      form.append('rows', p.rows);
      form.append('margin', String(SCAN_MARGIN));
      if (res.matPoint) {
        // Ponto tocado na foto → posição dentro do tabuleiro retificado (com a margem)
        const toUnit = Grid.homography(res.corners.map(([x, y]) => [x * img.width, y * img.height]), [[0, 0], [1, 0], [1, 1], [0, 1]]);
        const [u, v] = Grid.apply(toUnit, res.matPoint[0] * img.width, res.matPoint[1] * img.height);
        const mx = (u * p.cols + SCAN_MARGIN) / (p.cols + 2 * SCAN_MARGIN);
        const my = (v * p.rows + SCAN_MARGIN) / (p.rows + 2 * SCAN_MARGIN);
        if (mx >= 0 && mx <= 1 && my >= 0 && my <= 1) form.append('mat_points', JSON.stringify([[mx, my]]));
      }

      if (apiWakeup) await apiWakeup;
      const resp = await fetchWithTimeout(`${getApiUrl()}/api/scan-board`, { method: 'POST', headers: await authHeaders(), body: form }, 120000);
      if (!resp.ok) throw new Error(await apiErrorMessage(resp, 'Não foi possível analisar o tabuleiro.'));
      const data = await resp.json();
      setServiceStatus('api', 'ok', 'Online');

      grid.scanMap = data.placed_map;
      grid.board = { img, corners: res.corners };
      grid.hole = null;
      Workspace.onScanned();
      scanOverlay.src = `data:image/jpeg;base64,${data.overlay_base64}`;
      show(scanDetails);
      updateGridCounts();
      await renderMapImage();
      if (grid.cell) selectCell(grid.cell.col, grid.cell.row);
      notify(`Tabuleiro escaneado: ${data.placed} montadas, ${data.missing} faltando.`, 'success', 6000);
      try {
        await persistScanMap();
      } catch (err) {
        notify(`Mapa salvo só neste aparelho: ${err.message}`, 'error');
      }
    } catch (err) {
      notify(err.name === 'AbortError' ? 'O servidor demorou demais. Tente de novo em instantes.' : err.message, 'error', 7000);
    } finally {
      hide(scanLoading, 'flex');
    }
  });
}

// ==========================================
// 8. SCANNER DE CÂMERA EM TEMPO REAL (AR)
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
    notify(gridActive() ? 'Primeiro escolha no mapa a peça que falta.' : 'Primeiro toque no ponto da imagem da caixa onde a peça fica.', 'info');
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
    // Mapa: a mesa pode ter centenas de peças pequenas, então manda o quadro com mais resolução
    const targetW = Math.min(scannerVideo.videoWidth, gridActive() ? 1920 : 960);
    const targetH = Math.round((scannerVideo.videoHeight * targetW) / scannerVideo.videoWidth);
    captureCanvas.width = targetW;
    captureCanvas.height = targetH;
    captureCanvas.getContext('2d').drawImage(scannerVideo, 0, 0, targetW, targetH);

    const frameBlob = await new Promise(res => captureCanvas.toBlob(res, 'image/jpeg', 0.8));
    if (!frameBlob) return;

    // 2. Envia só as coordenadas de volta (annotate=false): resposta leve a cada quadro
    const byCell = gridActive();
    const res = await fetchWithTimeout(`${getApiUrl()}/api/${byCell ? 'find-cell' : 'find-piece'}`, {
      method: 'POST',
      headers: await authHeaders(),
      body: byCell ? await buildFindCellForm([frameBlob], { annotate: false }) : buildFindPieceForm([frameBlob], { annotate: false })
    }, 60000);

    if (session !== scanSession) return;

    if (serviceStatus.api !== 'ok') {
      setServiceStatus('api', 'ok', 'Online');
      hide(apiNotice, 'flex');
    }

    if (res.ok) {
      const data = await res.json();
      if (session !== scanSession) return;
      // Formato comum: a busca por célula devolve candidatos; a avulsa, uma peça só
      renderARMatch(data.candidates
        ? { confident: data.confident, candidates: data.candidates }
        : { confident: data.confident, candidates: [{ rank: 1, bbox: data.bbox, centroid: data.centroid, rotation_deg: data.rotation_deg }], shape_similarity: data.shape_similarity },
        targetW, targetH);
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

  // Demais candidatos: círculos finos numerados (o nº 1 é desenhado por cima, em destaque)
  data.candidates.slice(1).forEach((c) => {
    const x = c.centroid[0] * t.scale + t.offsetX, y = c.centroid[1] * t.scale + t.offsetY;
    const r = Math.max(c.bbox[2], c.bbox[3]) * t.scale * 0.7;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.85)';
    ctx.stroke();
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(String(c.rank), x + r * 0.7, y - r * 0.7);
  });

  const best = data.candidates[0];
  const [, , bw, bh] = best.bbox;
  const [cx, cy] = best.centroid;

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

  let detailText = rotationLabel(best.rotation_deg);
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
// 9. INICIALIZAÇÃO
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
  checkReady();
  apiWakeup = checkApiHealth();
  initSupabase();
});
