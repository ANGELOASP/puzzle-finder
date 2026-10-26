// ==========================================
// BUSCA EM LOTES
// Manda as fotos das peças ao servidor de 3 em 3 (memória do plano gratuito), junta os resultados,
// pode parar cedo quando a peça já é "muito provável" e continuar de onde parou depois de uma queda.
// Usa tablePhotos, PHOTOS_PER_REQUEST e os helpers de rede de app.js (carregado antes deste arquivo).
// ==========================================
const Search = (() => {
  const idxOf = (photo) => tablePhotos.indexOf(photo);

  // Conexão caída no meio (servidor reiniciando ou acordando): espera o servidor voltar e tenta mais uma vez
  async function fetchWithRetry(url, options, timeoutMs) {
    try {
      return await fetchWithTimeout(url, options, timeoutMs);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      try {
        await fetchWithTimeout(`${getApiUrl()}/healthz`, {}, 75000);
        return await fetchWithTimeout(url, options, timeoutMs);
      } catch (err2) {
        if (err2.name === 'AbortError') throw err2;
        throw new Error('O servidor de análise não respondeu. Ele pode ter reiniciado: tente de novo, com menos fotos de uma vez se continuar.');
      }
    }
  }

  // Monta as fotos de um pedido. Foto que o servidor já separou (tem `key`) vai só como referência, sem reenviar o
  // arquivo; as outras vão como arquivo. Aceita também Blobs soltos (quadro da câmera ao vivo).
  function appendPhotos(form, photos) {
    const refs = [];
    let uploads = 0;
    for (const p of photos) {
      if (!(p instanceof Blob) && p.key) {
        refs.push({ key: p.key });
      } else {
        form.append('table_files', p instanceof Blob ? p : p.blob, `pecas-${uploads + 1}.jpg`);
        refs.push({ upload: uploads++ });
      }
    }
    form.append('photo_refs', JSON.stringify(refs));
  }

  // Arte da caixa: depois da 1ª resposta o servidor devolve a chave dela e o app só manda a chave
  function appendArt(form) {
    if (grid.artKey) form.append('box_key', grid.artKey);
    else form.append('box_file', grid.artBlob, 'art.jpg');
  }

  /**
   * Envia as fotos em lotes, um depois do outro.
   * `parts`: acumulador [{ photos, data }]. Ele é preenchido lote a lote, então depois de uma falha (ou de uma
   * parada antecipada) basta chamar de novo com o mesmo array para continuar sem refazer os lotes prontos.
   * `data === null`: lote sem nenhuma peça aproveitável (o servidor respondeu 404).
   * `stopWhen(parts)`: devolve true para parar antes do fim; o resultado traz as fotos que sobraram em `remaining`.
   */
  async function run(path, photos, buildForm, { parts = [], timeoutMs = 120000, errorText, onBatch, onPart, stopWhen } = {}) {
    const done = new Set(parts.flatMap((p) => p.photos));
    const todo = photos.filter((p) => !done.has(p));
    let skipped = 0, lastError = null;
    for (let start = 0; start < todo.length; start += PHOTOS_PER_REQUEST) {
      const chunk = todo.slice(start, start + PHOTOS_PER_REQUEST);
      if (onBatch) onBatch({ from: done.size + start, to: done.size + start + chunk.length, total: photos.length });
      const send = async () => fetchWithRetry(`${getApiUrl()}${path}`, {
        method: 'POST', headers: await authHeaders(), body: await buildForm(chunk),
      }, timeoutMs);
      let res = await send();
      if (res.status === 409) {
        // O servidor não guardava mais essas fotos (reiniciou, ou o cache encheu): reenvia o arquivo delas
        let missing = [];
        let missingBox = false;
        try {
          const detail = (await res.json()).detail || {};
          missing = detail.missing || [];
          missingBox = Boolean(detail.missing_box);
        } catch (_) { /* resposta sem lista */ }
        if (missingBox) grid.artKey = null;
        chunk.forEach((p) => { if (!p.key || missing.includes(p.key)) p.key = null; });
        res = await send();
      }
      if (res.status === 404) {
        skipped += chunk.length;
        lastError = new Error(await apiErrorMessage(res, errorText));
        parts.push({ photos: chunk, data: null });
        if (onPart) onPart(parts);
        continue;
      }
      if (!res.ok) throw new Error(await apiErrorMessage(res, errorText));
      const data = await res.json();
      if (data.box_key) grid.artKey = data.box_key;
      chunk.forEach((p, i) => {
        const info = (data.photos || [])[i];
        if (!info) return;
        p.pieceCount = info.pieces;
        if (info.key) p.key = info.key; // da próxima vez o app manda só a chave
      });
      parts.push({ photos: chunk, data });
      if (onPart) onPart(parts);
      const rest = todo.slice(start + PHOTOS_PER_REQUEST);
      if (rest.length && stopWhen && stopWhen(parts)) return { parts, stopped: true, remaining: rest, skipped };
    }
    if (!parts.some((p) => p.data)) throw lastError || new Error(errorText);
    if (skipped > 1 || (skipped && photos.length > PHOTOS_PER_REQUEST)) {
      notify(`${skipped} ${skipped === 1 ? 'foto não teve' : 'fotos não tiveram'} peças aproveitáveis e ${skipped === 1 ? 'ficou' : 'ficaram'} de fora.`, 'info', 6000);
    }
    return { parts, stopped: false, remaining: [], skipped };
  }

  // ---------- Juntar os lotes ----------
  const okParts = (parts) => parts.filter((p) => p.data);
  const detected = (parts) => okParts(parts).reduce((n, p) => n + (p.data.pieces_detected || 0), 0);

  // Resumo de cada foto na posição dela em tablePhotos (foto sem resultado fica null)
  function photosSummary(parts) {
    const out = tablePhotos.map(() => null);
    for (const part of okParts(parts)) {
      (part.data.photos || []).forEach((ph, i) => {
        const g = idxOf(part.photos[i]);
        if (g >= 0) out[g] = ph;
      });
    }
    return out;
  }

  const localToGlobal = (part, local) => idxOf(part.photos[local] || part.photos[0]);

  // Buraco → peça: junta as candidatas de todos os lotes e refaz a confiança na lista geral
  function mergeFindCell(parts) {
    const ok = okParts(parts);
    if (!ok.length) return null;
    const cands = [];
    for (const part of ok) {
      part.data.candidates.forEach((c, i) => {
        cands.push({ ...c, photo: localToGlobal(part, c.photo), batchConfident: i === 0 && part.data.confident });
      });
    }
    cands.sort((a, b) => b.score - a.score);
    const top = cands.slice(0, 5).map((c, i) => ({ ...c, rank: i + 1 }));
    // Mesmo critério do servidor (margem de 12 pontos sobre a 2ª), agora contra as candidatas de todos os lotes
    const confident = Boolean(top[0] && top[0].batchConfident && (top.length < 2 || top[0].score - top[1].score >= 12));
    return {
      ...ok[0].data,
      candidates: top,
      confident,
      pieces_detected: detected(parts),
      photos: photosSummary(parts),
      annotated_tables: ok.flatMap((part) => (part.data.annotated_tables || []).map((x) => ({ ...x, photo: localToGlobal(part, x.photo) }))),
    };
  }

  // Modo sem mapa: fica o lote com a peça mais parecida
  function mergeFindPiece(parts) {
    const ok = okParts(parts);
    if (!ok.length) return null;
    const best = ok.reduce((a, b) => ((b.data.score || 0) > (a.data.score || 0) ? b : a));
    const d = best.data;
    const images = d.annotated_tables || [{ photo: d.photo || 0, image_base64: d.annotated_table_base64 }];
    return {
      ...d,
      photo: localToGlobal(best, d.photo || 0),
      annotated_tables: images.map((x) => ({ ...x, photo: localToGlobal(best, x.photo) })),
      // No modo sem mapa o servidor não manda `candidates`: o campo continua ausente (lista vazia mudaria o fluxo)
      candidates: d.candidates ? d.candidates.map((c) => ({ ...c, photo: localToGlobal(best, c.photo) })) : undefined,
      pieces_detected: detected(parts),
      photos: photosSummary(parts),
    };
  }

  // Peças → mapa: todas as peças de todos os lotes. O id carrega o id da foto (estável ao salvar a sessão)
  function mergeLocate(parts) {
    const ok = okParts(parts);
    if (!ok.length) return null;
    return {
      ...ok[0].data,
      pieces: ok.flatMap((part) => part.data.pieces.map((pc) => {
        const photo = part.photos[pc.photo] || part.photos[0];
        return { ...pc, id: `${photo.id}-${pc.id}`, photoId: photo.id, photo: idxOf(photo) };
      })),
      pieces_detected: detected(parts),
      photos: photosSummary(parts),
    };
  }

  // ---------- Contagem das peças achadas em cada foto ----------
  // Só separa e conta (rota leve, que também deixa as fotos no cache do servidor para as buscas seguintes).
  // Preenche em cada foto: pieceCount, boxes (onde está cada peça, no quadro da foto), frame e key.
  async function count(photos, { pieceMm, onBatch, onPart } = {}) {
    const parts = [];
    const buildForm = (chunk) => {
      const form = new FormData();
      appendPhotos(form, chunk);
      if (pieceMm) form.append('piece_mm', String(pieceMm));
      return form;
    };
    await run('/api/count-pieces', photos, buildForm, {
      parts, timeoutMs: 180000, errorText: 'Não foi possível contar as peças.', onBatch,
      onPart: (ps) => {
        const last = ps[ps.length - 1];
        if (last && last.data) {
          last.photos.forEach((photo, i) => {
            const info = (last.data.photos || [])[i];
            if (!info) return;
            photo.pieceCount = info.count;
            photo.boxes = info.found || [];
            photo.frame = info.frame_size;
            photo.whiteRef = info.white_ref;
            photo.counted = true;
          });
        }
        if (onPart) onPart(ps);
      },
    });
    return parts;
  }

  // ---------- Fotos: identidade e conclusão ----------
  const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

  function newPhoto(blob, issues = []) {
    return {
      id: newId(), blob, url: URL.createObjectURL(blob), issues, confirmed: [], done: false, key: null,
      pieceCount: 0, boxes: [], frame: null, counted: false, // contagem do servidor
      userCount: null, countOk: false,                       // o que o usuário confirmou
    };
  }

  // Foto concluída: todas as peças dela já foram encaixadas. Ela sai das próximas buscas (dá para voltar a incluir).
  // `placedIn`: quantas peças da foto o localizador já deu como encaixadas, `locatedIn`: quantas ele localizou.
  // Quantas peças a foto tem: o número que o usuário confirmou, senão a contagem do servidor
  const expected = (photo) => (photo.userCount != null ? photo.userCount : photo.pieceCount);

  function updateDone(photo, { placedIn = 0, locatedIn = 0 } = {}) {
    const total = expected(photo);
    if (photo.done || !total) return false;
    const placed = Math.max(photo.confirmed.length, placedIn);
    const byCount = placed >= total;
    // Peças sem silhueta não entram no localizador: sobram até 2 sem que a foto deixe de estar concluída
    const byLocate = locatedIn > 0 && placedIn >= locatedIn && total - locatedIn <= 2;
    if (!(byCount || byLocate)) return false;
    photo.done = true;
    return true;
  }

  return { run, count, expected, appendPhotos, appendArt, mergeFindCell, mergeFindPiece, mergeLocate, newPhoto, updateDone, idxOf };
})();
