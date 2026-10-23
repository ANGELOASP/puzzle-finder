const boxInput = document.getElementById('boxInput');
const tableInput = document.getElementById('tableInput');
const boxPreview = document.getElementById('boxPreview');
const tablePreview = document.getElementById('tablePreview');
const boxContainer = document.getElementById('boxContainer');
const tableContainer = document.getElementById('tableContainer');
const targetPin = document.getElementById('targetPin');
const boxHint = document.getElementById('boxHint');
const btnFind = document.getElementById('btnFind');
const loading = document.getElementById('loading');
const resultSection = document.getElementById('resultSection');
const apiUrlInput = document.getElementById('apiUrl');

let boxFile = null, tableFile = null;
let targetPercentX = 0.5, targetPercentY = 0.5, hasSelectedTarget = false;

const DEFAULT_API_URL = 'https://puzzle-finder-api.onrender.com';
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

boxInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    boxFile = e.target.files[0];
    const reader = new FileReader();
    reader.onload = (ev) => {
      boxPreview.src = ev.target.result;
      boxContainer.classList.remove('hidden');
      boxHint.classList.remove('hidden');
      checkReady();
    };
    reader.readAsDataURL(boxFile);
  }
});

boxPreview.addEventListener('click', (e) => {
  const rect = boxPreview.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;
  targetPercentX = clickX / rect.width;
  targetPercentY = clickY / rect.height;

  targetPin.style.left = `${clickX}px`;
  targetPin.style.top = `${clickY}px`;
  targetPin.classList.remove('hidden');
  hasSelectedTarget = true;
  checkReady();
});

tableInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    tableFile = e.target.files[0];
    const reader = new FileReader();
    reader.onload = (ev) => {
      tablePreview.src = ev.target.result;
      tableContainer.classList.remove('hidden');
      checkReady();
    };
    reader.readAsDataURL(tableFile);
  }
});

function checkReady() {
  if (boxFile && tableFile && hasSelectedTarget) btnFind.disabled = false;
}

btnFind.addEventListener('click', async () => {
  if (!boxFile || !tableFile) return;

  const backendUrl = apiUrlInput.value.replace(/\/$/, '');
  const formData = new FormData();
  formData.append('box_file', boxFile);
  formData.append('table_file', tableFile);
  formData.append('target_x_ratio', targetPercentX);
  formData.append('target_y_ratio', targetPercentY);

  btnFind.disabled = true;
  loading.classList.remove('hidden');
  resultSection.classList.add('hidden');

  try {
    const res = await fetch(`${backendUrl}/api/find-piece`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Falha no processamento.');
    }
    const data = await res.json();
    document.getElementById('pieceCrop').src = `data:image/jpeg;base64,${data.piece_crop_base64}`;
    document.getElementById('highlightedTable').src = `data:image/jpeg;base64,${data.annotated_table_base64}`;
    document.getElementById('rotationTag').innerText = `Girar: ${data.rotation_deg}° para encaixar`;
    resultSection.classList.remove('hidden');
    resultSection.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    alert(`Erro: ${err.message}`);
  } finally {
    loading.classList.add('hidden');
    btnFind.disabled = false;
  }
});
