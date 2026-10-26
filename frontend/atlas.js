// ==========================================
// ATLAS REAL
// Cada foto de buraco mostra as peças vizinhas de verdade, nítidas e na cor real. O servidor devolve um recorte de cada
// vizinha já na orientação da arte; o app guarda no projeto (compartilhado entre aparelhos e pessoas) e a tela de
// comparar mostra esses recortes reais no lugar da arte da caixa, que é mais borrada e de outra cor.
// Os recortes ficam no bucket puzzle-photos, na pasta <projeto>/atlas (as mesmas regras de acesso das fotos).
// ==========================================
const Atlas = (() => {
  const BUCKET = 'puzzle-photos';
  const patches = new Map();   // "col,row" → ImageBitmap
  let pid = null;
  let listTimer = null;

  const key = (c, r) => `${c},${r}`;
  const path = (c, r) => `${pid}/atlas/c_${c}_${r}.jpg`;
  const get = (c, r) => patches.get(key(c, r)) || null;

  function changed() {
    if (typeof Workspace !== 'undefined' && Workspace.atlasChanged) Workspace.atlasChanged();
  }

  async function decode(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'image/jpeg' });
  }

  // Vizinhas de uma foto de buraco: guarda no aparelho na hora e sobe para o projeto em segundo plano
  async function add(list) {
    if (!pid || !list || !list.length) return 0;
    let n = 0;
    for (const p of list) {
      if (!p.patch) continue;
      const blob = await decode(p.patch);
      try { patches.set(key(p.col, p.row), await createImageBitmap(blob)); n++; } catch (_) { continue; }
      if (supabaseClient) supabaseClient.storage.from(BUCKET).upload(path(p.col, p.row), blob, { contentType: 'image/jpeg', upsert: true }).catch(() => {});
    }
    if (n) changed();
    return n;
  }

  // Traz os recortes do projeto (de outros aparelhos e pessoas). Só baixa o que ainda não tem.
  async function load() {
    if (!pid || !supabaseClient) return;
    const mine = pid;
    const { data, error } = await supabaseClient.storage.from(BUCKET).list(`${mine}/atlas`, { limit: 1000 });
    if (error || !data) return;
    const todo = [];
    for (const f of data) {
      const m = /^c_(\d+)_(\d+)\.jpg$/.exec(f.name);
      if (m && !patches.has(key(m[1], m[2]))) todo.push([+m[1], +m[2]]);
    }
    let got = 0;
    const worker = async () => {
      while (todo.length && pid === mine) {
        const [c, r] = todo.shift();
        const { data: blob } = await supabaseClient.storage.from(BUCKET).download(`${mine}/atlas/c_${c}_${r}.jpg`);
        if (!blob || pid !== mine) continue;
        try { patches.set(key(c, r), await createImageBitmap(blob)); got++; } catch (_) { /* arquivo inválido */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (got) changed();
  }

  function start(puzzle) {
    stop();
    if (!puzzle) return;
    pid = puzzle.id;
    setTimeout(load, 3000);
    listTimer = setInterval(load, 60000);
  }

  function stop() {
    clearInterval(listTimer);
    pid = null;
    patches.clear();
  }

  return { add, get, start, stop, count: () => patches.size };
})();
