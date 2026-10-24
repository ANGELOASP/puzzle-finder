"""
Mapa por grade: com colunas × linhas conhecidas, cada peça tem posição exata na arte.

O frontend endireita (perspectiva) as fotos com os 4 cantos marcados pelo usuário e envia:
  - box_rect: a arte da caixa já retificada, exatamente cols × rows células;
  - board_rect: o tabuleiro retificado com uma faixa extra de `margin` células em volta
    (a mesa/feltro ao redor), usada para aprender a cor do fundo vazio.
"""
import cv2
import numpy as np

from puzzle_engine import ROTATIONS, _rotate

# Tamanho (px) da célula usado no escaneamento: pequeno basta e deixa 2000 células rápidas
SCAN_CELL = 24
# Margem da célula ignorada no escaneamento (abas/encaixes das vizinhas)
SCAN_INSET = 0.2
# Deslocamentos (fração da célula) testados para tolerar cantos marcados com pouca precisão
SCAN_OFFSETS = (-0.15, 0.0, 0.15)
# Célula com confiança abaixo disso adota a maioria das vizinhas
SCAN_SMOOTH_BELOW = 0.25
SCAN_KEEP_ISOLATED = 0.95
# Sementes do auto-treino: desenho que bate com a arte (montada) e vazio contínuo ao toque (fundo)
ART_SEED_NCC = 0.75
ART_SEED_MIN_TEXTURE = 6.0
MAT_SEED_MAX_NCC = 0.55
MAT_FLOOD_STEP = 12.0      # diferença de cor máxima entre duas células vazias vizinhas
MAT_FLOOD_FROM_TAP = 50.0  # ... e em relação ao ponto tocado
# Sem sementes suficientes, decisão fixa (logit): cor mais perto da arte que do fundo + correlação
COLOR_WEIGHT = 2.0
NCC_WEIGHT = 4.0
NCC_NEUTRAL = 0.45

# Tamanho (px) da célula na busca da peça
MATCH_CELL = 64
# Lado do corpo da peça ≈ k × raio do maior círculo inscrito na máscara (sem/ com encaixes fundos)
BODY_FROM_RADIUS = (2.0, 2.3, 2.6, 3.0)
# Com a escala da folha A4, o corpo é conhecido: testa só ±8% (corte e impressão variam um pouco)
KNOWN_BODY_STEPS = (0.92, 1.0, 1.08)
# O centro do corpo pode estar até esta fração de célula longe do centro da célula
MATCH_REACH = 0.3
MIN_TEXTURE_STD = 8.0

# Confiança da busca por célula (calibrada no bench sintético de peças com encaixes)
MIN_CELL_SCORE = 0.62
MIN_CELL_MARGIN = 0.06

SIDES = ("top", "right", "bottom", "left")
# Formato dos lados (fração do lado do corpo): faixa do meio (aba/encaixe), faixa perto dos cantos
# (corpo) e diferença mínima entre as duas para contar como aba ou encaixe (≈ 0,25 numa peça comum)
SIDE_MID_BAND = 0.15
SIDE_CORNER_BAND = (0.28, 0.40)
SIDE_SHAPE_MIN = 0.10
# Buraco no tabuleiro: célula reamostrada para HOLE_CELL px; tolerância mínima de cor do vazio;
# quanto (fração da célula) o buraco pode passar da linha da célula perto dos cantos antes de "vazar"
HOLE_CELL = 48
HOLE_MIN_TOL = 10.0
HOLE_LEAK = 0.2
# Peso de cada lado da peça que não bate com o buraco (filtro suave)
HOLE_MISMATCH = 0.85
# ... contando no máximo estes lados: 3-4 lados "errados" costumam ser a peça endireitada errado, não outra peça
HOLE_MAX_MISMATCHES = 2


def _block_means(lab, x0, y0, w, h, blocks=3):
    patch = lab[int(y0):int(y0 + h), int(x0):int(x0 + w)]
    if patch.shape[0] < blocks or patch.shape[1] < blocks:
        return None
    return cv2.resize(patch, (blocks, blocks), interpolation=cv2.INTER_AREA).reshape(-1, 3)


def _lab(img_bgr):
    return cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)


def scan_board(box_rect, board_rect, cols, rows, margin, mat_points=None):
    """
    Classifica cada célula do tabuleiro como montada ou vazia.
    `mat_points`: pontos (x, y normalizados no board_rect) que o usuário tocou numa área vazia
    (feltro/madeira) — a referência mais confiável do fundo.
    Retorna dict(placed: rows×cols de bool, confidence: matriz 0..1, mat_found: bool).

    Cada foto se calibra sozinha: células cujo DESENHO bate com a arte (correlação, que não liga
    para luz nem para o tom da foto) e a área vazia contínua ao toque viram exemplos; um
    classificador linear treinado nesses exemplos decide o resto (arte lisa, madeira de outro tom).
    """
    bh, bw = board_rect.shape[:2]
    cwi, chi = bw / (cols + 2 * margin), bh / (rows + 2 * margin)
    cw = SCAN_CELL
    ch = max(8, int(round(SCAN_CELL * chi / cwi)))
    bsize = (int(round((cols + 2 * margin) * cw)), int(round((rows + 2 * margin) * ch)))
    raw = cv2.resize(board_rect, bsize, interpolation=cv2.INTER_AREA)
    board = cv2.GaussianBlur(_lab(raw), (0, 0), 1.0)
    box = cv2.GaussianBlur(_lab(cv2.copyMakeBorder(cv2.resize(box_rect, (cols * cw, rows * ch), interpolation=cv2.INTER_AREA),
                                                   ch, ch, cw, cw, cv2.BORDER_REPLICATE)), (0, 0), 1.0)
    mpx, mpy = margin * cw, margin * ch
    iw = 3 * max(1, int(round(cw * (1 - 2 * SCAN_INSET) / 3)))
    ih = 3 * max(1, int(round(ch * (1 - 2 * SCAN_INSET) / 3)))
    n_off = len(SCAN_OFFSETS) ** 2

    # 1. Miolo de cada célula no tabuleiro e na arte (com pequenos deslocamentos)
    bp = np.zeros((rows, cols, ih, iw, 3), np.float32)
    xp = np.zeros((rows, cols, n_off, ih, iw, 3), np.float32)
    for r in range(rows):
        for c in range(cols):
            x, y = int(mpx + (c + SCAN_INSET) * cw), int(mpy + (r + SCAN_INSET) * ch)
            bp[r, c] = board[y:y + ih, x:x + iw]
            k = 0
            for oy in SCAN_OFFSETS:
                for ox in SCAN_OFFSETS:
                    X, Y = int(cw + (c + SCAN_INSET + ox) * cw), int(ch + (r + SCAN_INSET + oy) * ch)
                    xp[r, c, k] = box[Y:Y + ih, X:X + iw]
                    k += 1

    # 2. Correlação do desenho (melhor deslocamento) e descritores de cor
    a = bp - bp.mean((2, 3), keepdims=True)
    bx = xp - xp.mean((3, 4), keepdims=True)
    num = (a[:, :, None] * bx).sum((3, 4, 5))
    den = np.sqrt((a ** 2).sum((2, 3, 4))[:, :, None] * (bx ** 2).sum((3, 4, 5))) + 1e-6
    ncc_all = num / den
    best = ncc_all.argmax(-1)
    ncc = ncc_all.max(-1)
    b_mean, b_std = bp.mean((2, 3)), bp.std((2, 3)).mean(-1)
    art_tex = xp[:, :, n_off // 2].std((2, 3)).mean(-1)
    b_blocks = bp.reshape(rows, cols, 3, ih // 3, 3, iw // 3, 3).mean((3, 5)).reshape(rows, cols, 9, 3)
    x_blocks = xp.reshape(rows, cols, n_off, 3, ih // 3, 3, iw // 3, 3).mean((4, 6)).reshape(rows, cols, n_off, 9, 3)
    valid = raw.reshape(-1, 3).max(1).reshape(raw.shape[:2]) > 12

    # Luminância pesa menos: a luz da foto do tabuleiro varia mais que a cor
    weights = np.array([0.5, 1.0, 1.0], np.float32)

    def cdist(u, v):
        return np.sqrt((((u - v) * weights) ** 2).sum(-1))

    # 3. Fundo vazio: toque do usuário (inundando as vazias vizinhas de cor parecida) ou faixa em volta
    mat_seed = np.zeros((rows, cols), bool)
    mat_ref = []
    for (px, py) in (mat_points or []):
        c, r = int(px * (cols + 2 * margin) - margin), int(py * (rows + 2 * margin) - margin)
        if 0 <= r < rows and 0 <= c < cols:
            mat_seed[r, c] = True
            mat_ref.append(b_mean[r, c])
        else:
            X, Y = int(px * bsize[0]), int(py * bsize[1])
            patch = board[max(0, Y - ch // 2):Y + ch // 2 + 1, max(0, X - cw // 2):X + cw // 2 + 1].reshape(-1, 3)
            if len(patch):
                mat_ref.append(np.median(patch, 0))
    if not mat_ref:
        ring = np.ones(board.shape[:2], bool)
        ring[int(mpy):int(mpy + rows * ch), int(mpx):int(mpx + cols * cw)] = False
        ring_px = board[ring & valid]
        if ring_px.shape[0] > 50:
            mat_ref.append(np.median(ring_px, 0))
    if mat_ref:
        ref = np.array(mat_ref, np.float32)
        near_ref = cdist(b_mean[:, :, None], ref[None, None]).min(-1) < MAT_FLOOD_FROM_TAP
        if not mat_seed.any():  # sem toque dentro da grade: começa pelas células mais parecidas com a faixa
            start = near_ref & (ncc < MAT_SEED_MAX_NCC) & (cdist(b_mean[:, :, None], ref[None, None]).min(-1) < MAT_FLOOD_FROM_TAP / 3)
            mat_seed |= start
        mat_seed = _flood(mat_seed, b_mean, near_ref & (ncc < MAT_SEED_MAX_NCC), cdist)
    else:
        # Foto cortada rente e sem toque: o vazio é o grupo de cor coerente das células sem desenho da arte
        low = ncc < np.percentile(ncc, 20)
        if low.sum() >= 10:
            m0 = np.median(b_mean[low], 0)
            mat_seed = low & (cdist(b_mean, m0) < MAT_FLOOD_FROM_TAP / 2)
    mat_found = bool(mat_seed.sum() >= 5)

    # 4. Montadas certas: o desenho bate com a arte numa célula com textura
    art_seed = (ncc > ART_SEED_NCC) & (art_tex > ART_SEED_MIN_TEXTURE) & ~mat_seed

    # 5. Tom/luz da arte ajustados ao tabuleiro (linear por canal) só com as montadas certas
    gain, bias = np.ones(3, np.float32), np.zeros(3, np.float32)
    if art_seed.sum() >= 12:
        idx = np.argwhere(art_seed)
        src = x_blocks[idx[:, 0], idx[:, 1], best[art_seed]].reshape(-1, 3)
        dst = b_blocks[art_seed].reshape(-1, 3)
        for chn in range(3):
            A = np.stack([src[:, chn], np.ones(len(src))], 1)
            (g, b0), *_ = np.linalg.lstsq(A, dst[:, chn], rcond=None)
            if 0.3 < g < 3.0:
                gain[chn], bias[chn] = g, b0
    d_art = cdist(b_blocks[:, :, None], x_blocks * gain + bias).mean(-1).min(-1)
    if mat_found:
        seeds = b_mean[mat_seed]
        d_mat = np.full((rows, cols), np.inf, np.float32)
        for i in range(0, len(seeds), 256):  # vizinho mais próximo entre os exemplos de fundo
            d_mat = np.minimum(d_mat, cdist(b_mean[:, :, None], seeds[None, None, i:i + 256]).min(-1))
    else:
        d_mat = np.full((rows, cols), 40.0, np.float32)

    # 6. Classificador treinado nas sementes desta foto
    feats = np.stack([ncc, np.log1p(d_art), np.log1p(d_mat), np.log1p(b_std),
                      np.log1p(d_mat) - np.log1p(d_art)], -1).reshape(-1, 5)
    if mat_seed.sum() >= 5 and art_seed.sum() >= 5:
        logit = _fit_logit(feats, art_seed.ravel(), mat_seed.ravel()).reshape(rows, cols)
    else:
        logit = COLOR_WEIGHT * (np.log1p(d_mat) - np.log1p(d_art)) + NCC_WEIGHT * (ncc - NCC_NEUTRAL)
    prob = 1 / (1 + np.exp(-logit))
    prob = np.where(art_seed, np.maximum(prob, 0.9), prob)
    prob = np.where(mat_seed, np.minimum(prob, 0.1), prob)
    placed = prob > 0.5
    confidence = np.abs(prob - 0.5) * 2

    # 7. Células duvidosas seguem a maioria das 8 vizinhas; "montada" ilhada no vazio (7+ vizinhas
    # vazias) também, a não ser que o desenho bata com certeza: peça solta no lugar exato, cercada de
    # vazio, é rara. O contrário (um buraco no meio da área montada) é o caso mais comum e fica.
    p = placed.astype(np.float32)
    neigh = cv2.filter2D(p, -1, np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], np.float32), borderType=cv2.BORDER_REPLICATE) / 8
    doubtful = confidence < SCAN_SMOOTH_BELOW
    isolated = placed & (neigh <= 1 / 8) & (confidence < SCAN_KEEP_ISOLATED)
    placed = np.where(doubtful | isolated, neigh >= 0.5, placed)

    return {"placed": placed, "confidence": confidence, "mat_found": mat_found}


def _fit_logit(x, pos, neg, iters=400, l2=0.01):
    """Regressão logística (classes balanceadas) treinada em `pos`/`neg`; devolve o logit de todos."""
    mu, sd = x.mean(0), x.std(0) + 1e-6
    xn = (x - mu) / sd
    sel = pos | neg
    xs, ys = xn[sel], pos[sel].astype(np.float32)
    wts = np.where(ys > 0, 0.5 / ys.mean(), 0.5 / (1 - ys.mean()))
    w, b = np.zeros(x.shape[1]), 0.0
    for _ in range(iters):
        g = (1 / (1 + np.exp(-(xs @ w + b))) - ys) * wts
        w -= 0.5 * (xs.T @ g / len(ys) + l2 * w)
        b -= 0.5 * g.mean()
    return xn @ w + b


def _flood(seed, color, allowed, cdist):
    """Expande `seed` para células vizinhas (4) permitidas cuja cor muda pouco de uma para a outra."""
    out = seed.copy()
    rows, cols = seed.shape
    stack = [tuple(p) for p in np.argwhere(seed)]
    while stack:
        r, c = stack.pop()
        for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
            if 0 <= rr < rows and 0 <= cc < cols and not out[rr, cc] and allowed[rr, cc] \
                    and cdist(color[rr, cc], color[r, c]) < MAT_FLOOD_STEP:
                out[rr, cc] = True
                stack.append((rr, cc))
    return out


def draw_scan(board_rect, cols, rows, margin, placed):
    """Tabuleiro retificado (sem a margem) com as células vazias em vermelho e a grade."""
    bh, bw = board_rect.shape[:2]
    cwi, chi = bw / (cols + 2 * margin), bh / (rows + 2 * margin)
    x0, y0 = int(round(margin * cwi)), int(round(margin * chi))
    img = board_rect[y0:y0 + int(round(rows * chi)), x0:x0 + int(round(cols * cwi))].copy()
    overlay = img.copy()
    for r in range(rows):
        for c in range(cols):
            if not placed[r][c]:
                cv2.rectangle(overlay, (int(c * cwi), int(r * chi)), (int((c + 1) * cwi), int((r + 1) * chi)), (60, 60, 230), -1)
    img = cv2.addWeighted(overlay, 0.45, img, 0.55, 0)
    for c in range(cols + 1):
        cv2.line(img, (int(c * cwi), 0), (int(c * cwi), img.shape[0]), (255, 255, 255), 1)
    for r in range(rows + 1):
        cv2.line(img, (0, int(r * chi)), (img.shape[1], int(r * chi)), (255, 255, 255), 1)
    return img


def cell_patch(box_rect, cols, rows, col, row):
    """Região da arte em volta da célula, normalizada para a célula medir MATCH_CELL px de largura."""
    h, w = box_rect.shape[:2]
    cwi, chi = w / cols, h / rows
    scale = MATCH_CELL / cwi
    cx, cy = (col + 0.5) * cwi, (row + 0.5) * chi
    half_w, half_h = cwi * 1.8, chi * 1.8
    # Peças da beirada: completa a janela replicando a borda da arte (o lado reto não usa essa área)
    pad = int(np.ceil(max(half_w, half_h))) + 1
    padded = cv2.copyMakeBorder(box_rect, pad, pad, pad, pad, cv2.BORDER_REPLICATE)
    x1, y1 = int(cx - half_w) + pad, int(cy - half_h) + pad
    x2, y2 = int(cx + half_w) + pad, int(cy + half_h) + pad
    region = padded[y1:y2, x1:x2]
    x1, y1 = x1 - pad, y1 - pad
    img = cv2.resize(region, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
    return {
        "image": img,
        "center": ((cx - x1) * scale, (cy - y1) * scale),
        "cell": (MATCH_CELL, chi * scale),
        # Quantos px a célula tem na arte original: a peça da mesa é borrada até essa resolução
        "native_cell": cwi,
        "expected_flats": expected_flats(cols, rows, col, row),
    }


def expected_flats(cols, rows, col, row):
    return frozenset(s for s, cond in zip(SIDES, (row == 0, col == cols - 1, row == rows - 1, col == 0)) if cond)


def _longest_run(flags, max_gap=2):
    """Maior trecho contínuo de True, tolerando falhas curtas (serrilhado da segmentação)."""
    best = cur = gap = 0
    for f in flags:
        if f:
            cur += gap + 1
            gap = 0
        elif cur and gap < max_gap:
            gap += 1
        else:
            cur = gap = 0
        best = max(best, cur)
    return best


def piece_flats(upright_mask):
    """
    Lados retos da peça (borda/canto do quebra-cabeça).
    Mede o maior trecho contínuo encostado em cada lado do recorte e compara com o lado do corpo
    (≈ √área, já que abas e encaixes se compensam): lado reto ≈ 0,8-1 corpo; aba ou encaixe ≤ ~0,4.
    """
    if upright_mask is None:
        return frozenset()
    m = upright_mask > 127
    h, w = m.shape
    if h < 8 or w < 8:
        return frozenset()
    body = float(np.sqrt(m.sum()))
    band = max(2, int(round(body * 0.08)))
    runs = {
        "top": _longest_run(m[:band].any(0)),
        "bottom": _longest_run(m[h - band:].any(0)),
        "left": _longest_run(m[:, :band].any(1)),
        "right": _longest_run(m[:, w - band:].any(1)),
    }
    return frozenset(side for side, run in runs.items() if run >= 0.62 * body)


def side_shapes(mask):
    """
    Formato de cada lado de uma silhueta endireitada (peça solta ou buraco no tabuleiro):
    {"top"|"right"|"bottom"|"left": "tab" | "blank" | "flat"}, ou None se a máscara for pequena.
    Compara quanto a silhueta avança no MEIO do lado (onde ficam aba e encaixe) com quanto avança
    perto dos CANTOS (o próprio corpo). A caixa do corpo vem dos cantos, não do recorte: as abas
    aumentariam o recorte.
    """
    if mask is None:
        return None
    m = mask > 127
    ys, xs = np.nonzero(m)
    if len(xs) < 50:
        return None
    # Caixa inicial do corpo: centroide ± √área/2 (abas e encaixes se compensam na área; o recorte
    # inteiro seria até 1,5× maior que o corpo numa peça com 4 abas)
    half = 0.5 * np.sqrt(len(xs))
    box = [xs.mean() - half, ys.mean() - half, xs.mean() + half, ys.mean() + half]  # x0, y0, x1, y1
    shapes = None
    for _ in range(3):
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        body = min(box[2] - box[0], box[3] - box[1])
        if body < 8:
            return None
        shapes, corner_ext = {}, {}
        for side in SIDES:
            out, inn, corner = _side_extent(m, side, cx, cy, body)
            if out is None or corner is None:
                return None
            # Aba: algum ponto do meio sai bem além do corpo; encaixe: algum ponto entra bem nele
            # (o meio inteiro, não só o centro: abas costumam ficar um pouco deslocadas)
            if (out - corner) / body > SIDE_SHAPE_MIN:
                shapes[side] = "tab"
            elif (corner - inn) / body > SIDE_SHAPE_MIN:
                shapes[side] = "blank"
            else:
                shapes[side] = "flat"
            corner_ext[side] = corner
        box = [cx - corner_ext["left"], cy - corner_ext["top"], cx + corner_ext["right"], cy + corner_ext["bottom"]]
    return shapes


def _side_extent(m, side, cx, cy, body):
    """Distância do centro até a silhueta na direção de `side`: maior e menor no meio do lado, mediana perto dos cantos."""
    h, w = m.shape
    # Vira a máscara para que `side` seja o de cima
    if side == "top":
        mm, ax, ay = m, cx, cy
    elif side == "bottom":
        mm, ax, ay = m[::-1], cx, h - 1 - cy
    elif side == "left":
        mm, ax, ay = m.T, cy, cx
    else:
        mm, ax, ay = m[:, ::-1].T, cy, w - 1 - cx
    first = np.where(mm.any(0), mm.argmax(0), -1)  # 1ª linha com silhueta em cada coluna

    def extents(lo, hi, n):
        cols = [int(round(ax + f * body)) for f in np.linspace(lo, hi, n)]
        return [ay - first[c] for c in cols if 0 <= c < len(first) and first[c] >= 0]

    mid = extents(-SIDE_MID_BAND, SIDE_MID_BAND, 11)
    corners = extents(-SIDE_CORNER_BAND[1], -SIDE_CORNER_BAND[0], 5) + extents(SIDE_CORNER_BAND[0], SIDE_CORNER_BAND[1], 5)
    if len(mid) < 3 or len(corners) < 3:
        return None, None, None
    # 2º maior/menor: um pixel solto não vira aba
    mid = np.sort(mid)
    return float(mid[-2]), float(mid[1]), float(np.median(corners))


def hole_shapes(board_rect, cols, rows, margin, col, row, flats=None):
    """
    Formato do buraco de uma célula vazia no tabuleiro retificado: as abas das vizinhas montadas
    entram no buraco (lá a peça que falta tem encaixe) e os encaixes delas o alargam (lá ela tem aba).
    Retorna {lado: "tab"|"blank"|"flat"|None} — None quando a vizinha daquele lado também falta (o
    buraco "vaza") ou a foto não deixa medir — ou None se nem o centro da célula parecer vazio.
    `board_rect` pode ser o tabuleiro inteiro ou um recorte de 3 × 3 células (cols=rows=3, col=row=1).
    """
    bh, bw = board_rect.shape[:2]
    cwi, chi = bw / (cols + 2 * margin), bh / (rows + 2 * margin)
    # Janela de 2 × 2 células centrada na célula, com a célula em ~HOLE_CELL px
    s = HOLE_CELL / cwi
    x0, y0 = (margin + col - 0.5) * cwi, (margin + row - 0.5) * chi
    M = np.array([[s, 0, -x0 * s], [0, s, -y0 * s]], np.float32)
    size = (int(round(2 * cwi * s)), int(round(2 * chi * s)))
    win = cv2.warpAffine(board_rect, M, size, flags=cv2.INTER_AREA, borderMode=cv2.BORDER_REPLICATE)
    lab = cv2.GaussianBlur(_lab(win), (0, 0), 1.2)
    h, w = lab.shape[:2]
    cw, ch = w / 2, h / 2  # tamanho da célula na janela
    cx, cy = w / 2, h / 2
    core = lab[int(cy - 0.15 * ch):int(cy + 0.15 * ch), int(cx - 0.15 * cw):int(cx + 0.15 * cw)].reshape(-1, 3)
    ref = np.median(core, 0)
    weights = np.array([0.6, 1.0, 1.0], np.float32)
    d = np.sqrt((((lab - ref) * weights) ** 2).sum(-1))
    spread = float(np.percentile(np.sqrt((((core - ref) * weights) ** 2).sum(-1)), 90))
    empty = (d < max(HOLE_MIN_TOL, 2.5 * spread)).astype(np.uint8)
    k = max(3, int(round(0.08 * cw)) | 1)
    empty = cv2.morphologyEx(empty, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    n, cc = cv2.connectedComponents(empty)
    lab_c = cc[int(cy), int(cx)]
    if lab_c == 0:
        return None
    hole = cc == lab_c
    # Tapa riscos do veio/partes escuras dentro do buraco
    hole = cv2.morphologyEx(hole.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))) > 0
    area = hole.sum() / float(cw * ch)
    if area < 0.4:
        return None
    out = {}
    for side in SIDES:
        res = _side_extent(hole, side, cx, cy, cw)
        outer, inner, corner = res
        if corner is None:
            out[side] = None
            continue
        # Vazou: o buraco segue bem além da linha da célula também perto dos cantos (vizinha vazia)
        if corner > 0.5 * cw + HOLE_LEAK * cw:
            out[side] = None
        elif (outer - corner) / cw > SIDE_SHAPE_MIN:
            out[side] = "tab"
        elif (corner - inner) / cw > SIDE_SHAPE_MIN:
            out[side] = "blank"
        else:
            out[side] = "flat"
    # Lados na borda do quebra-cabeça são retos por definição (`flats`: quando a imagem é só um
    # recorte em volta da célula, a borda real vem de fora)
    for side in (expected_flats(cols, rows, col, row) if flats is None else flats):
        out[side] = "flat"
    return out


def rotate_sides(sides, deg):
    """Lados após girar a peça `deg` graus no sentido horário."""
    k = (deg // 90) % 4
    return frozenset(SIDES[(SIDES.index(s) + k) % 4] for s in sides)


def rotate_shapes(shapes, deg):
    """Formato dos lados após girar a peça `deg` graus no sentido horário."""
    k = (deg // 90) % 4
    return {SIDES[(SIDES.index(side) + k) % 4]: kind for side, kind in shapes.items()}


def shape_mismatches(piece_shapes, hole, deg):
    """Quantos lados conhecidos do buraco não batem com a peça girada `deg` (None: nada a comparar)."""
    if not piece_shapes or not hole:
        return None
    rot = rotate_shapes(piece_shapes, deg)
    known = [side for side, kind in hole.items() if kind is not None]
    return sum(rot[side] != hole[side] for side in known) if known else None


def _body_frame(piece):
    """
    Peça endireitada em Lab, máscara e centro/raio do corpo (ponto mais interno da máscara).
    A comparação usa a silhueta inteira: as abas mostram a arte das vizinhas e ajudam muito
    quando a própria célula é lisa (céu, fundo).
    """
    up, m = piece.get("upright"), piece.get("upright_mask")
    if up is None or m is None:
        return None
    binary = (m > 127).astype(np.uint8)
    dt = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    _, radius, _, center = cv2.minMaxLoc(dt)
    if radius < 4:
        return None
    # Tira 2 px da beirada: ali a cor mistura peça e mesa
    inner = cv2.erode(binary, np.ones((5, 5), np.uint8)) * 255
    return cv2.cvtColor(up, cv2.COLOR_BGR2LAB), inner, radius, center


def _rotate_point(pt, w, h, deg):
    """Coordenada de um ponto após girar a imagem w×h `deg` graus no sentido horário."""
    x, y = pt
    if deg == 90:
        return (h - 1 - y, x)
    if deg == 180:
        return (w - 1 - x, h - 1 - y)
    if deg == 270:
        return (y, w - 1 - x)
    return (x, y)


def _lab_hist(lab_u8, mask=None):
    """
    Histograma Lab (luz em 4 faixas, cor em 16 × 16) suavizado entre bins vizinhos: uma pequena
    diferença de tom entre as fotos cai no bin ao lado em vez de zerar a semelhança.
    """
    h = cv2.calcHist([lab_u8], [0, 1, 2], mask, list(HIST_BINS), [0, 256, 0, 256, 0, 256]).reshape(HIST_BINS)
    for ax in (1, 2):
        h = (h + np.roll(h, 1, ax) * 0.5 + np.roll(h, -1, ax) * 0.5) / 2.0
    total = float(h.sum())
    return (h / total).astype(np.float32).ravel() if total > 0 else h.astype(np.float32).ravel()


def _color_similarity(h1, h2):
    """1 − distância de Bhattacharyya (0..1)."""
    return 1.0 - float(cv2.compareHist(h1, h2, cv2.HISTCMP_BHATTACHARYYA))


class ColorNormalizer:
    """
    Leva as cores da foto da mesa para as da caixa (transferência de Reinhard em Lab): média e
    desvio de cada canal das peças viram os da arte das células que elas devem preencher. Corrige o
    que muda entre as duas fotos (luz quente, câmera, impressão mais saturada) — no bench com fotos
    reais, a célula certa saiu da 80ª para a 1ª-3ª posição entre 201 pela cor.
    """

    def __init__(self, piece_px, art_px):
        self.mb, self.ma = piece_px.mean(0), art_px.mean(0)
        self.k = np.clip(art_px.std(0) / (piece_px.std(0) + 1e-6), 1 / COLOR_MAX_STRETCH, COLOR_MAX_STRETCH)

    def __call__(self, lab_u8):
        out = (lab_u8.astype(np.float32) - self.mb) * self.k + self.ma
        return np.clip(out, 0, 255).astype(np.uint8)


def color_normalizer(pieces, box_rect, cols, rows, scan_map=None):
    """
    Normalizador a partir das peças da(s) foto(s) e da arte. As peças soltas são as que faltam no
    tabuleiro: com o mapa do escaneamento ('0' = falta), a referência é a arte só dessas células.
    """
    piece_px = []
    rng = np.random.default_rng(0)
    for p in pieces:
        lab = cv2.cvtColor(p["crop"], cv2.COLOR_BGR2LAB).reshape(-1, 3)
        px = lab[(p["mask"] > 127).ravel()]
        if len(px):
            piece_px.append(px[rng.choice(len(px), min(len(px), 400), replace=False)])
    if not piece_px:
        return None
    art = cv2.cvtColor(box_rect, cv2.COLOR_BGR2LAB)
    h, w = art.shape[:2]
    if scan_map and len(scan_map) == cols * rows and scan_map.count("0") >= COLOR_MIN_MISSING:
        missing = np.array([ch == "0" for ch in scan_map]).reshape(rows, cols)
        sel = cv2.resize(missing.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
        art_px = art[sel]
    else:
        art_px = art.reshape(-1, 3)
    art_px = art_px[rng.choice(len(art_px), min(len(art_px), 200000), replace=False)]
    return ColorNormalizer(np.concatenate(piece_px).astype(np.float32), art_px.astype(np.float32))


# Histograma de cor (luz, a, b) e quanto a normalização de cor pode esticar o desvio de um canal
HIST_BINS = (4, 16, 16)
COLOR_MAX_STRETCH = 2.0
# Mínimo de células faltando para usar só elas como referência de cor da arte
COLOR_MIN_MISSING = 20

# Com centenas de peças na mesa, só as N mais parecidas na cor (e com bordas compatíveis)
# passam pela comparação fina, que é a parte cara
PREFILTER_KEEP = 60


def match_cell(patch, pieces, top_k=5, hole=None, color_tf=None):
    """
    Ordena as peças da mesa pela semelhança com a célula-alvo da arte.
    `hole`: formato do buraco no tabuleiro (hole_shapes), se conhecido — cada lado que não bate com
    a peça naquela rotação pesa HOLE_MISMATCH (filtro suave: a medida dos lados pode errar).
    `color_tf`: ColorNormalizer das fotos da mesa para as cores da caixa (cor e desenho).
    Retorna lista (melhor primeiro) de dict(piece, rotation, score, visual, color, flats_ok, shape_ok).
    """
    region_lab = cv2.cvtColor(patch["image"], cv2.COLOR_BGR2LAB)
    rh, rw = region_lab.shape[:2]
    cx, cy = patch["center"]
    cell_w, cell_h = patch["cell"]
    reach = MATCH_REACH * cell_w
    expected = patch["expected_flats"]

    # Histograma de cor da célula (com um pouco das vizinhas, como as abas da peça)
    hx1, hy1 = int(max(0, cx - cell_w * 0.65)), int(max(0, cy - cell_h * 0.65))
    hx2, hy2 = int(min(rw, cx + cell_w * 0.65)), int(min(rh, cy + cell_h * 0.65))
    cell_hist = _lab_hist(region_lab[hy1:hy2, hx1:hx2])
    # Célula lisa (céu, fundo): o desenho não diferencia peças, a cor sim → peso do visual pela textura
    cell_std = float(region_lab[hy1:hy2, hx1:hx2, 0].std())
    w_visual = float(np.clip(cell_std / 25.0, 0.25, 0.75))

    down = patch.get("native_cell", cell_w) / cell_w

    # Pré-filtro barato: histograma de cor + lados retos compatíveis com a posição da célula
    use_hole = bool(hole) and any(v is not None for v in hole.values())

    def shape_factor(shapes, deg):
        miss = shape_mismatches(shapes, hole, deg) if use_hole else None
        return 1.0 if miss is None else HOLE_MISMATCH ** min(miss, HOLE_MAX_MISMATCHES)

    pre = []
    for piece in pieces:
        flats = piece_flats(piece.get("upright_mask"))
        flats_ok = any(rotate_sides(flats, deg) == expected for deg, _ in ROTATIONS)
        shapes = side_shapes(piece.get("upright_mask")) if use_hole else None
        best_shape = max(shape_factor(shapes, deg) for deg, _ in ROTATIONS)
        piece_lab = cv2.cvtColor(piece["crop"], cv2.COLOR_BGR2LAB)
        if color_tf is not None:
            piece_lab = color_tf(piece_lab)
        color = _color_similarity(cell_hist, _lab_hist(piece_lab, piece["mask"]))
        pre.append((color * (1.0 if flats_ok else 0.5) * best_shape, color, flats, shapes, piece))
    pre.sort(key=lambda t: t[0], reverse=True)

    results = []
    for _, color, flats, shapes, piece in pre[:PREFILTER_KEEP]:
        frame = _body_frame(piece)
        if frame is None:
            continue
        lab_full, mask_full, radius, body_c = frame
        if color_tf is not None:
            lab_full = color_tf(lab_full)
        texture = min(1.0, float(lab_full[:, :, 0][mask_full > 0].std()) / MIN_TEXTURE_STD) if (mask_full > 0).any() else 0.0

        best, best_rot = -1.0, 0
        allowed = [deg for deg, _ in ROTATIONS if rotate_sides(flats, deg) == expected]
        flats_ok = bool(allowed)
        # Corpo da peça em px: conhecido pela folha A4 (mm × px/mm) ou estimado pelo raio inscrito
        bodies = [piece["body_px"] * f for f in KNOWN_BODY_STEPS] if piece.get("body_px") \
            else [k * radius for k in BODY_FROM_RADIUS]
        for body in bodies:
            # O corpo mede cell_w px na arte normalizada
            scale = cell_w / body
            tw, th = int(round(lab_full.shape[1] * scale)), int(round(lab_full.shape[0] * scale))
            if tw < 8 or th < 8:
                continue
            tpl_lab = cv2.resize(lab_full, (tw, th), interpolation=cv2.INTER_AREA)
            # A arte da caixa costuma ter bem menos px por peça que a foto da mesa: iguala a nitidez
            if down < 0.9:
                small = (max(2, int(round(tw * down))), max(2, int(round(th * down))))
                tpl_lab = cv2.resize(cv2.resize(tpl_lab, small, interpolation=cv2.INTER_AREA), (tw, th),
                                     interpolation=cv2.INTER_CUBIC)
            tpl_mask = cv2.resize(mask_full, (tw, th), interpolation=cv2.INTER_NEAREST)
            bc = (body_c[0] * scale, body_c[1] * scale)
            for deg, code in ROTATIONS:
                if flats_ok and deg not in allowed:
                    continue
                tpl = _rotate(tpl_lab, code)
                tm = _rotate(tpl_mask, code)
                t_h, t_w = tpl.shape[:2]
                bx, by = _rotate_point(bc, tw, th, deg)
                # Posições em que o centro do corpo fica a até `reach` do centro da célula
                xa, ya = int(np.floor(cx - bx - reach)), int(np.floor(cy - by - reach))
                xb, yb = int(np.ceil(cx - bx + reach)) + t_w + 1, int(np.ceil(cy - by + reach)) + t_h + 1
                xa, ya, xb, yb = max(0, xa), max(0, ya), min(rw, xb), min(rh, yb)
                if xb - xa < t_w or yb - ya < t_h or not tm.any():
                    continue
                m3 = cv2.merge([tm.astype(np.float32) / 255.0] * 3)
                res = cv2.matchTemplate(region_lab[ya:yb, xa:xb].astype(np.float32), tpl.astype(np.float32),
                                        cv2.TM_CCOEFF_NORMED, mask=m3)
                v = float(np.nanmax(res)) if np.isfinite(res).any() else -1.0
                s_ = v * texture
                # A rotação escolhida também precisa encaixar no buraco
                if s_ * shape_factor(shapes, deg) > best * shape_factor(shapes, best_rot):
                    best, best_rot = s_, deg

        score = w_visual * max(0.0, best) + (1 - w_visual) * color
        if not flats_ok:
            score *= 0.5  # borda/canto na posição errada: quase certamente outra peça
        factor = shape_factor(shapes, best_rot)
        score *= factor
        results.append({"piece": piece, "rotation": best_rot, "score": score, "visual": best,
                        "color": color, "flats_ok": flats_ok,
                        "shape_ok": None if not use_hole else factor == 1.0})

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:top_k]


def is_confident(ranked):
    if not ranked:
        return False
    margin = ranked[0]["score"] - (ranked[1]["score"] if len(ranked) > 1 else 0.0)
    return (ranked[0]["score"] >= MIN_CELL_SCORE and margin >= MIN_CELL_MARGIN and ranked[0]["flats_ok"]
            and ranked[0].get("shape_ok") is not False)


def draw_candidates(table_bgr, ranked, confident, ranks=None):
    """
    Circula os candidatos numerados: 1 em verde (ou âmbar se incerto), os demais em cinza-claro.
    `ranks`: posição (0 = melhor) de cada candidato na lista geral, quando a foto tem só alguns deles.
    """
    out = table_bgr.copy()
    ranks = list(range(len(ranked))) if ranks is None else ranks
    for i, cand in reversed(list(zip(ranks, ranked))):
        x, y, w, h = cand["piece"]["bbox"]
        cx, cy = cand["piece"]["centroid"]
        radius = int(max(w, h) * 0.75)
        if i == 0:
            color, thick = ((0, 220, 0) if confident else (0, 200, 255)), 6
        else:
            color, thick = (230, 230, 230), 3
        cv2.circle(out, (cx, cy), radius, color, thick, cv2.LINE_AA)
        label = str(i + 1)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.9, 2)
        lx, ly = int(cx + radius * 0.7), int(cy - radius * 0.7)
        cv2.circle(out, (lx, ly), int(max(tw, th) * 0.9), (0, 0, 0), -1, cv2.LINE_AA)
        cv2.putText(out, label, (lx - tw // 2, ly + th // 2), cv2.FONT_HERSHEY_SIMPLEX, 0.9, color, 2, cv2.LINE_AA)
    return out
