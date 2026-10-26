// ==========================================
// COLABORAÇÃO: vários logins no mesmo quebra-cabeça
// - Convite por link (?convite=...) e criação de conta direto do convite
// - Fotos das peças sincronizadas entre aparelhos (tirou no celular, aparece no desktop e vice-versa)
// - Mapa (peças montadas) e contagem de peças encontradas atualizados para todos
// Depende das tabelas de supabase/colaboracao.sql. Sem elas o app segue funcionando só neste aparelho.
// ==========================================
const Collab = (() => {
  const $ = (id) => document.getElementById(id);
  const INVITE_KEY = 'pf_invite';
  const POLL_MS = 8000;
  const BUCKET = 'puzzle-photos';
  let timer = null;
  let pushTimer = null;
  let readyTimer = null;
  let pid = null;           // quebra-cabeça sincronizado
  let busy = false;
  let ready = false;        // só sincroniza depois de a sessão salva deste aparelho voltar (senão uma sobrescreve a outra)
  let lastError = null;
  const known = new Map();  // id da foto → assinatura do que já foi enviado/recebido
  const removedIds = new Set(); // fotos que o usuário removeu aqui (só estas são apagadas nos outros aparelhos)

  // ---------- Convite ----------
  function readInviteFromUrl() {
    try {
      const u = new URL(location.href);
      const t = u.searchParams.get('convite');
      if (t) {
        localStorage.setItem(INVITE_KEY, t);
        u.searchParams.delete('convite');
        history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash);
      }
    } catch (_) { /* sem storage */ }
  }
  readInviteFromUrl();

  const pendingInvite = () => { try { return localStorage.getItem(INVITE_KEY); } catch (_) { return null; } };

  // Banner na tela de login: quem chegou por convite entende por que precisa entrar ou criar a conta
  function showInviteBanner() {
    const el = $('inviteBanner');
    if (el) el.classList.toggle('hidden', !pendingInvite());
  }

  // Depois do login: entra no projeto do convite. Devolve o id do projeto (para abrir direto) ou null.
  async function onSignedIn() {
    const token = pendingInvite();
    if (!token || !supabaseClient) return null;
    try {
      const { data, error } = await supabaseClient.rpc('accept_invite', { p_token: token });
      if (error) throw error;
      localStorage.removeItem(INVITE_KEY);
      notify('Você entrou no projeto compartilhado.', 'success', 5000);
      return data;
    } catch (err) {
      localStorage.removeItem(INVITE_KEY);
      notify(`Não foi possível entrar pelo convite: ${err.message || err}. Peça um link novo.`, 'error', 9000);
      return null;
    }
  }

  async function createAccount(email, password) {
    const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) return { error };
    // Sem sessão: o projeto exige confirmar o e-mail antes de entrar
    return { confirm: !data.session };
  }

  // ---------- Diálogo "Compartilhar projeto" ----------
  const inviteUrl = (token) => `${location.origin}${location.pathname}?convite=${token}`;

  async function openShare() {
    if (!currentPuzzle || !supabaseClient) { notify('Abra um quebra-cabeça para compartilhar.', 'info'); return; }
    $('shareName').textContent = currentPuzzle.name;
    $('shareLink').value = '';
    $('shareMsg').textContent = '';
    if (!$('shareDialog').open) $('shareDialog').showModal();
    await renderMembers();
  }

  async function renderMembers() {
    const list = $('shareMembers');
    list.innerHTML = '';
    const li = (text, extra) => {
      const el = document.createElement('li');
      el.className = 'flex items-center justify-between gap-2 py-1.5 text-sm text-slate-200';
      const s = document.createElement('span'); s.className = 'truncate'; s.textContent = text; el.appendChild(s);
      if (extra) el.appendChild(extra);
      list.appendChild(el);
    };
    const owner = currentPuzzle.user_id === (currentUser && currentUser.id);
    li(owner ? `${currentUser.email} (você, dono)` : 'Dono do projeto');
    const { data, error } = await supabaseClient.from('puzzle_members').select('user_id,email').eq('puzzle_id', currentPuzzle.id);
    if (error) { $('shareMsg').textContent = 'O compartilhamento ainda não foi ativado no banco (falta rodar o SQL de colaboração).'; return; }
    for (const m of data) {
      let btn = null;
      if (owner && m.user_id !== currentUser.id) {
        btn = document.createElement('button');
        btn.type = 'button'; btn.textContent = 'Remover';
        btn.className = 'text-xs font-semibold text-rose-300 underline underline-offset-2 h-8 shrink-0';
        btn.addEventListener('click', async () => {
          await supabaseClient.from('puzzle_members').delete().eq('puzzle_id', currentPuzzle.id).eq('user_id', m.user_id);
          renderMembers();
        });
      }
      li(m.user_id === currentUser.id ? `${m.email || 'Você'} (você)` : (m.email || 'Participante'), btn);
    }
  }

  async function createInvite() {
    $('shareMsg').textContent = '';
    const { data, error } = await supabaseClient.from('puzzle_invites').insert([{ puzzle_id: currentPuzzle.id }]).select('token').single();
    if (error) { $('shareMsg').textContent = `Não foi possível criar o link: ${error.message}`; return; }
    const url = inviteUrl(data.token);
    $('shareLink').value = url;
    $('shareMsg').textContent = 'Link válido por 7 dias. Quem abrir entra (ou cria a conta) e passa a ver o mesmo projeto.';
    try { await navigator.clipboard.writeText(url); $('shareMsg').textContent = 'Link copiado. ' + $('shareMsg').textContent; } catch (_) { /* copia manual */ }
  }

  async function shareLink() {
    const url = $('shareLink').value;
    if (!url) return;
    if (navigator.share) { try { await navigator.share({ title: 'PuzzleFinder', text: `Participe do quebra-cabeça "${currentPuzzle.name}"`, url }); return; } catch (_) { /* cancelou */ } }
    try { await navigator.clipboard.writeText(url); notify('Link copiado.', 'success'); } catch (_) { $('shareLink').select(); }
  }

  // ---------- Sincronização ----------
  const sig = (p) => JSON.stringify([p.done, p.confirmed, p.userCount, p.countOk]);
  const rowOf = (p, path) => ({
    id: p.id, puzzle_id: pid, path, done: p.done, confirmed: p.confirmed || [], user_count: p.userCount, count_ok: p.countOk,
    deleted: false, updated_at: new Date().toISOString(),
  });
  const pathOf = (p) => `${pid}/${p.id}.jpg`;

  function applyRemote(photo, row) {
    photo.done = row.done;
    photo.confirmed = Array.isArray(row.confirmed) ? row.confirmed : [];
    photo.userCount = row.user_count;
    photo.countOk = row.count_ok;
    known.set(photo.id, sig(photo));
  }

  async function pull() {
    const { data: rows, error } = await supabaseClient.from('puzzle_photos').select('*').eq('puzzle_id', pid).order('created_at');
    if (error) { lastError = error.message; return false; }
    let changed = false;
    const toDownload = [];
    for (const row of rows) {
      const local = tablePhotos.find((p) => p.id === row.id);
      if (row.deleted) {
        if (local) { URL.revokeObjectURL(local.url); tablePhotos.splice(tablePhotos.indexOf(local), 1); changed = true; }
        known.set(row.id, 'deleted');
        continue;
      }
      if (!local) {
        if (!removedIds.has(row.id)) toDownload.push(row); // removida aqui: o envio (push) apaga no banco
        continue;
      }
      if (known.has(row.id) && known.get(row.id) !== sig(local)) {
        // alteração local ainda não enviada: o envio (push) vence
      } else if (sig({ done: row.done, confirmed: row.confirmed || [], userCount: row.user_count, countOk: row.count_ok }) !== sig(local)) {
        applyRemote(local, row);
        changed = true;
      } else {
        known.set(row.id, sig(local));
      }
    }
    if (changed) { renderTablePhotos(); Workspace.onPhotosChanged(); }

    // Fotos novas: baixa 3 por vez e mostra cada uma assim que chega (são MB por foto; no celular leva um tempo)
    const room = Math.max(0, MAX_TABLE_PHOTOS - tablePhotos.length);
    const queue = toDownload.slice(0, room);
    let done = 0;
    const worker = async () => {
      while (queue.length && pid) {
        const row = queue.shift();
        status(`Baixando as fotos dos outros aparelhos… ${done + 1} de ${toDownload.length}`);
        const { data: blob, error: e2 } = await supabaseClient.storage.from(BUCKET).download(row.path);
        done++;
        if (e2 || !blob) { lastError = e2 ? e2.message : 'a foto não baixou'; continue; }
        if (tablePhotos.some((p) => p.id === row.id)) continue;
        const photo = Search.newPhoto(blob);
        photo.id = row.id;
        applyRemote(photo, row);
        tablePhotos.push(photo);
        renderTablePhotos();
        Workspace.onPhotosChanged();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return true;
  }

  async function push() {
    // novas fotos e alterações
    for (const p of [...tablePhotos]) {
      if (known.get(p.id) === 'deleted') continue;
      if (!known.has(p.id)) {
        const path = pathOf(p);
        const { error } = await supabaseClient.storage.from(BUCKET).upload(path, p.blob, { contentType: 'image/jpeg', upsert: true });
        if (error) { lastError = `envio da foto: ${error.message}`; continue; }
        const { error: e2 } = await supabaseClient.from('puzzle_photos').upsert([rowOf(p, path)]);
        if (e2) { lastError = `registro da foto: ${e2.message}`; continue; }
        known.set(p.id, sig(p));
      } else if (known.get(p.id) !== sig(p)) {
        const { error } = await supabaseClient.from('puzzle_photos').upsert([rowOf(p, pathOf(p))]);
        if (!error) known.set(p.id, sig(p)); else lastError = error.message;
      }
    }
    // fotos que o usuário removeu aqui
    for (const id of [...removedIds]) {
      const { error } = await supabaseClient.from('puzzle_photos').update({ deleted: true, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) { lastError = error.message; continue; }
      await supabaseClient.storage.from(BUCKET).remove([`${pid}/${id}.jpg`]);
      known.set(id, 'deleted');
      removedIds.delete(id);
    }
  }

  // Mapa e contagem: o que os outros participantes marcaram
  async function pullPuzzle() {
    const { data, error } = await supabaseClient.from('puzzles').select('scan_map').eq('id', pid).single();
    if (!error && data && data.scan_map && data.scan_map !== grid.scanMap && grid.scanMap) {
      await applyRemoteScanMap(data.scan_map);
    }
    const { count } = await supabaseClient.from('found_pieces').select('*', { count: 'exact', head: true }).eq('puzzle_id', pid);
    if (count != null && count !== currentFoundCount) { currentFoundCount = count; updateProgressBar(); }
  }

  function status(text, bad) {
    const el = $('syncStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('hidden', !text);
    el.classList.toggle('text-amber-300', Boolean(bad));
    el.classList.toggle('text-slate-500', !bad);
  }

  async function tick(force) {
    if (busy || !ready || !pid || !supabaseClient || (document.hidden && force !== true)) return;
    busy = true;
    lastError = null;
    try {
      if (await pull()) { await push(); await pullPuzzle(); }
    } catch (err) { lastError = err.message || String(err); } finally { busy = false; }
    const n = [...known.values()].filter((v) => v !== 'deleted').length;
    status(lastError ? `Sincronização com os outros aparelhos falhou: ${lastError}` : `Sincronizado com os outros aparelhos · ${n} ${n === 1 ? 'foto' : 'fotos'} no projeto`, Boolean(lastError));
  }

  function start(puzzle) {
    stop();
    if (!puzzle || !isGridPuzzle(puzzle)) return;
    pid = puzzle.id;
    ready = false;
    known.clear();
    removedIds.clear();
    timer = setInterval(tick, POLL_MS);
    status('Sincronizando com os outros aparelhos…');
    // Se a sessão salva demorar demais para voltar, começa mesmo assim
    readyTimer = setTimeout(ready_, 8000);
  }

  // A sessão salva deste aparelho voltou: as fotos daqui sobem e as de lá descem
  function ready_() {
    if (!pid) return;
    ready = true;
    tick(true);
  }

  function removed(id) { if (pid) removedIds.add(id); }

  function stop() {
    clearInterval(timer); clearTimeout(pushTimer); clearTimeout(readyTimer);
    pid = null; ready = false; known.clear(); removedIds.clear();
    status('');
  }

  // Chamado a cada mudança de foto/confirmação: envia logo em vez de esperar o próximo ciclo
  function touch() {
    if (!pid || !ready) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(tick, 1500);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  $('btnShare').addEventListener('click', openShare);
  $('shareClose').addEventListener('click', () => $('shareDialog').close());
  $('shareCreate').addEventListener('click', createInvite);
  $('shareSend').addEventListener('click', shareLink);

  $('syncStatus').addEventListener('click', () => tick(true));

  return { onSignedIn, createAccount, showInviteBanner, start, stop, touch, pendingInvite, ready: ready_, removed };
})();
