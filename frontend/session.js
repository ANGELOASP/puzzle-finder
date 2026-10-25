// ==========================================
// SESSÃO SALVA NO APARELHO
// Fotos das peças, resultado do "onde vai cada peça" e o que foi confirmado ou recusado ficam no IndexedDB,
// um registro por quebra-cabeça. Fechar o app, recarregar a página ou perder a internet não perde o trabalho.
// (As peças confirmadas já ficam no banco de dados; aqui fica o que só existia na memória do navegador.)
// ==========================================
const Session = (() => {
  const DB_NAME = 'pf-session';
  const STORE = 'sessions';
  let dbPromise = null;
  let timer = null;
  let pending = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!window.indexedDB) { resolve(null); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (_) { resolve(null); return; }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // modo privado ou bloqueado: segue sem salvar
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve) => {
      if (!db) { resolve(null); return; }
      try {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(r && 'result' in r ? r.result : true);
        t.onerror = () => resolve(null);
        t.onabort = () => resolve(null);
      } catch (_) { resolve(null); }
    }));
  }

  const load = (puzzleId) => tx('readonly', (s) => s.get(puzzleId));
  const write = (puzzleId, snapshot) => tx('readwrite', (s) => s.put(snapshot, puzzleId));
  const remove = (puzzleId) => tx('readwrite', (s) => s.delete(puzzleId));

  // Salva depois de um instante parado (várias mudanças seguidas viram um único registro)
  function schedule(puzzleId, build, delay = 600) {
    pending = { puzzleId, build };
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  }

  function flush() {
    clearTimeout(timer);
    const job = pending;
    pending = null;
    if (!job) return Promise.resolve();
    let snapshot;
    try { snapshot = job.build(); } catch (_) { return Promise.resolve(); }
    return snapshot ? write(job.puzzleId, snapshot) : remove(job.puzzleId);
  }

  // Ao fechar ou esconder a página, salva o que estiver esperando
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  return { load, schedule, flush, remove };
})();
