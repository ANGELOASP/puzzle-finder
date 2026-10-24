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
SCAN_CELL = 32
# Miolo da célula comparado no escaneamento: fica longe das abas/encaixes das vizinhas
SCAN_INSET = 0.3
# Deslocamentos (fração da célula) testados para tolerar cantos marcados com pouca precisão
SCAN_OFFSETS = (-0.15, 0.0, 0.15)
# Célula com confiança abaixo disso adota a maioria das vizinhas
SCAN_SMOOTH_BELOW = 0.25

# Tamanho (px) da célula na busca da peça
MATCH_CELL = 64
# Lado do corpo da peça ≈ k × raio do maior círculo inscrito na máscara (sem/ com encaixes fundos)
BODY_FROM_RADIUS = (2.0, 2.3, 2.6, 3.0)
# O centro do corpo pode estar até esta fração de célula longe do centro da célula
MATCH_REACH = 0.3
MIN_TEXTURE_STD = 8.0

# Confiança da busca por célula (calibrada no bench sintético de peças com encaixes)
MIN_CELL_SCORE = 0.62
MIN_CELL_MARGIN = 0.06

SIDES = ("top", "right", "bottom", "left")


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
    (feltro/madeira) — a referência mais confiável da cor do fundo.
    Retorna dict(placed: lista rows×cols de bool, confidence: matriz, mat_found: bool).
    """
    bh, bw = board_rect.shape[:2]
    cell_w_in = bw / (cols + 2 * margin)
    cell_h_in = bh / (rows + 2 * margin)
    cw = SCAN_CELL
    ch = max(8, int(round(SCAN_CELL * cell_h_in / cell_w_in)))
    mpx, mpy = margin * cw, margin * ch

    board = _lab(cv2.resize(board_rect, (int(round((cols + 2 * margin) * cw)), int(round((rows + 2 * margin) * ch))),
                            interpolation=cv2.INTER_AREA))
    box = _lab(cv2.resize(box_rect, (cols * cw, rows * ch), interpolation=cv2.INTER_AREA))

    # 1. Cor do fundo vazio (feltro/mesa): faixa em volta do quebra-cabeça, ignorando área fora da foto (preta)
    ring = np.ones(board.shape[:2], bool)
    ring[int(mpy):int(mpy + rows * ch), int(mpx):int(mpx + cols * cw)] = False
    ring_px = board[ring]
    raw_ring = cv2.resize(board_rect, (board.shape[1], board.shape[0]), interpolation=cv2.INTER_AREA)[ring]
    ring_px = ring_px[raw_ring.max(axis=1) > 12]
    if mat_points:
        # Áreas vazias tocadas pelo usuário: amostra de ~1 célula em volta de cada ponto
        samples = []
        H, W = board.shape[:2]
        for (px, py) in mat_points:
            x, y = int(px * W), int(py * H)
            patch = board[max(0, y - ch // 2):y + ch // 2 + 1, max(0, x - cw // 2):x + cw // 2 + 1]
            if patch.size:
                samples.append(patch.reshape(-1, 3))
        if samples:
            ring_px = np.concatenate(samples)
    mat_found = ring_px.shape[0] > 50
    mat = np.median(ring_px, axis=0) if mat_found else None

    # Luminância pesa menos: a luz da foto do tabuleiro varia mais que a cor
    weights = np.array([0.5, 1.0, 1.0], np.float32)

    def dist(a, b):
        return np.sqrt((((a - b) * weights) ** 2).sum(-1)).mean(-1)

    # 2. Descritores 3×3 do miolo de cada célula (tabuleiro) e da arte (com pequenos deslocamentos)
    iw, ih = cw * (1 - 2 * SCAN_INSET), ch * (1 - 2 * SCAN_INSET)
    board_desc = np.zeros((rows, cols, 9, 3), np.float32)
    box_desc = np.zeros((rows, cols, len(SCAN_OFFSETS) ** 2, 9, 3), np.float32)
    for r in range(rows):
        for c in range(cols):
            bx, by = mpx + c * cw + cw * SCAN_INSET, mpy + r * ch + ch * SCAN_INSET
            board_desc[r, c] = _block_means(board, bx, by, iw, ih)
            k = 0
            for oy in SCAN_OFFSETS:
                for ox in SCAN_OFFSETS:
                    x0 = np.clip(c * cw + cw * (SCAN_INSET + ox), 0, cols * cw - iw)
                    y0 = np.clip(r * ch + ch * (SCAN_INSET + oy), 0, rows * ch - ih)
                    box_desc[r, c, k] = _block_means(box, x0, y0, iw, ih)
                    k += 1

    if not mat_found:
        # Foto cortada rente ao quebra-cabeça: aprende a cor do fundo pelas células que MENOS
        # se parecem com a arte (as vazias), desde que formem um grupo de cor coerente
        d0 = dist(board_desc[:, :, None], box_desc).min(-1)
        # Tenta do grupo mais restrito ao mais amplo: com poucas peças faltando, só o topo é vazio
        for pct in (95, 90, 80, 75):
            cand = board_desc[d0 >= np.percentile(d0, pct)].reshape(-1, 3)
            if cand.shape[0] < 20:
                continue
            m0 = np.median(cand, axis=0)
            close = np.linalg.norm((cand - m0) * weights, axis=1)
            if np.percentile(close, 50) < 18:  # vazio de cor parecida (feltro/madeira), não arte desalinhada
                ring_px = cand[close < np.percentile(close, 60)]
                mat = np.median(ring_px, axis=0)
                mat_found = True
                break

    if mat_found:
        d_mat = dist(board_desc, mat[None, None, None, :])
        mat_spread = max(4.0, float(np.percentile(dist(ring_px[:, None, :], mat[None, None, :]), 90)))
        placed = d_mat > 2.5 * mat_spread  # chute inicial: tudo que não parece feltro
    else:
        d_mat = None
        placed = np.ones((rows, cols), bool)

    # 3. Ajusta cor/luz da arte para a do tabuleiro (linear por canal) usando as células montadas, e refina
    gain, bias = np.ones(3, np.float32), np.zeros(3, np.float32)
    for _ in range(3):
        if placed.sum() >= 12:
            src = box_desc[:, :, len(SCAN_OFFSETS) ** 2 // 2][placed].reshape(-1, 3)
            dst = board_desc[placed].reshape(-1, 3)
            for chn in range(3):
                A = np.stack([src[:, chn], np.ones(len(src))], 1)
                (g, b0), *_ = np.linalg.lstsq(A, dst[:, chn], rcond=None)
                if 0.3 < g < 3.0:
                    gain[chn], bias[chn] = g, b0
        adjusted = box_desc * gain + bias
        d_art = dist(board_desc[:, :, None], adjusted).min(-1)

        if mat_found:
            score = d_mat / (d_mat + d_art + 1e-6)          # >0.5: mais parecido com a arte que com o feltro
            placed = score > 0.5
            confidence = np.abs(score - 0.5) * 2
        else:
            # Sem feltro visível: separa pela distância à arte (Otsu)
            v = np.clip(d_art / (np.percentile(d_art, 99) + 1e-6) * 255, 0, 255).astype(np.uint8)
            t, _ = cv2.threshold(v.reshape(-1, 1), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            placed = v <= t
            confidence = np.clip(np.abs(v.astype(np.float32) - t) / 128.0, 0, 1)

    # 4. Células duvidosas seguem a maioria das 8 vizinhas
    p = placed.astype(np.float32)
    neigh = cv2.filter2D(p, -1, np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], np.float32), borderType=cv2.BORDER_REPLICATE) / 8
    doubtful = confidence < SCAN_SMOOTH_BELOW
    placed = np.where(doubtful, neigh >= 0.5, placed)

    return {"placed": placed, "confidence": confidence, "mat_found": bool(mat_found)}


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


def rotate_sides(sides, deg):
    """Lados após girar a peça `deg` graus no sentido horário."""
    k = (deg // 90) % 4
    return frozenset(SIDES[(SIDES.index(s) + k) % 4] for s in sides)


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


def _ab_hist(lab_u8, mask=None):
    hist = cv2.calcHist([lab_u8], [1, 2], mask, [16, 16], [0, 256, 0, 256])
    return cv2.normalize(hist, hist).flatten()


# Com centenas de peças na mesa, só as N mais parecidas na cor (e com bordas compatíveis)
# passam pela comparação fina, que é a parte cara
PREFILTER_KEEP = 60


def match_cell(patch, pieces, top_k=5):
    """
    Ordena as peças da mesa pela semelhança com a célula-alvo da arte.
    Retorna lista (melhor primeiro) de dict(piece, rotation, score, visual, color, flats_ok).
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
    cell_hist = _ab_hist(region_lab[hy1:hy2, hx1:hx2])
    # Célula lisa (céu, fundo): o desenho não diferencia peças, a cor sim → peso do visual pela textura
    cell_std = float(region_lab[hy1:hy2, hx1:hx2, 0].std())
    w_visual = float(np.clip(cell_std / 25.0, 0.25, 0.75))

    down = patch.get("native_cell", cell_w) / cell_w

    # Pré-filtro barato: histograma de cor + lados retos compatíveis com a posição da célula
    pre = []
    for piece in pieces:
        flats = piece_flats(piece.get("upright_mask"))
        flats_ok = any(rotate_sides(flats, deg) == expected for deg, _ in ROTATIONS)
        piece_lab = cv2.cvtColor(piece["crop"], cv2.COLOR_BGR2LAB)
        color = (cv2.compareHist(cell_hist, _ab_hist(piece_lab, piece["mask"]), cv2.HISTCMP_CORREL) + 1) / 2
        pre.append((color * (1.0 if flats_ok else 0.5), color, flats, piece))
    pre.sort(key=lambda t: t[0], reverse=True)

    results = []
    for _, color, flats, piece in pre[:PREFILTER_KEEP]:
        frame = _body_frame(piece)
        if frame is None:
            continue
        lab_full, mask_full, radius, body_c = frame
        texture = min(1.0, float(lab_full[:, :, 0][mask_full > 0].std()) / MIN_TEXTURE_STD) if (mask_full > 0).any() else 0.0

        best, best_rot = -1.0, 0
        allowed = [deg for deg, _ in ROTATIONS if rotate_sides(flats, deg) == expected]
        flats_ok = bool(allowed)
        for k in BODY_FROM_RADIUS:
            # Corpo da peça ≈ k × raio → mede cell_w px na arte normalizada
            scale = cell_w / (k * radius)
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
                if s_ > best:
                    best, best_rot = s_, deg

        score = w_visual * max(0.0, best) + (1 - w_visual) * color
        if not flats_ok:
            score *= 0.5  # borda/canto na posição errada: quase certamente outra peça
        results.append({"piece": piece, "rotation": best_rot, "score": score, "visual": best,
                        "color": color, "flats_ok": flats_ok})

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:top_k]


def is_confident(ranked):
    if not ranked:
        return False
    margin = ranked[0]["score"] - (ranked[1]["score"] if len(ranked) > 1 else 0.0)
    return ranked[0]["score"] >= MIN_CELL_SCORE and margin >= MIN_CELL_MARGIN and ranked[0]["flats_ok"]


def draw_candidates(table_bgr, ranked, confident):
    """Circula os candidatos numerados: 1 em verde (ou âmbar se incerto), os demais em cinza-claro."""
    out = table_bgr.copy()
    for i, cand in reversed(list(enumerate(ranked))):
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
