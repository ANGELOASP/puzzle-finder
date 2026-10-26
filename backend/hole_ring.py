"""
Peças vizinhas REAIS de um buraco como referência de cor.

A foto de perto de um buraco mostra, na cor da câmera e em boa resolução, as peças já montadas em volta dele. Cada vizinha
está numa célula conhecida da arte da caixa, então ela vira um par "aparência real × arte da caixa" para calibrar a cor
(o mesmo que uma peça confirmada, só que sem precisar de nenhuma peça solta).

Como o celular pode estar girado, testa os 4 giros da foto e fica com o que melhor combina com a arte (correlação sem
depender da cor: tira a média e a escala de cada janela). Só devolve pares quando um giro se destaca claramente.
"""
import base64

import cv2
import numpy as np

import grid_engine as G

MIN_CORR = 0.45       # correlação mínima de uma vizinha com a arte da célula
MIN_MARGIN = 0.08     # o melhor giro tem de ganhar do 2º por esta folga (somada nas vizinhas)
NEIGHBOURS = ((-1, 0), (1, 0), (0, -1), (0, 1))


def _patch(img_lab, cx, cy, sx, sy):
    """Janela G×G (1,3 célula) centrada em (cx, cy) e o peso: 1 dentro do corpo da vizinha."""
    half_x, half_y = G.REV_WIN * sx / 2, G.REV_WIN * sy / 2
    kx, ky = G.REV_GRID / (2 * half_x), G.REV_GRID / (2 * half_y)
    M = np.float32([[kx, 0, -(cx - half_x) * kx], [0, ky, -(cy - half_y) * ky]])
    d = cv2.warpAffine(img_lab, M, (G.REV_GRID, G.REV_GRID), flags=cv2.INTER_AREA, borderMode=cv2.BORDER_REPLICATE)
    body = np.zeros(img_lab.shape[:2], np.float32)
    x0, x1 = int(round(cx - sx / 2)), int(round(cx + sx / 2))
    y0, y1 = int(round(cy - sy / 2)), int(round(cy + sy / 2))
    body[max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = 1.0
    w = cv2.warpAffine(body, M, (G.REV_GRID, G.REV_GRID), flags=cv2.INTER_AREA)
    w = cv2.erode(w, np.ones((3, 3), np.uint8))
    return d, w


def _corr(a, b, w):
    """Correlação ponderada (média das 3 bandas de Lab), sem depender de ganho nem de deslocamento da cor."""
    ww = w.reshape(-1)
    if ww.sum() < 8:
        return None
    out = []
    for c in range(3):
        x, y = a[..., c].reshape(-1).astype(np.float64), b[..., c].reshape(-1).astype(np.float64)
        mx, my = (x * ww).sum() / ww.sum(), (y * ww).sum() / ww.sum()
        vx, vy = (ww * (x - mx) ** 2).sum(), (ww * (y - my) ** 2).sum()
        if vx < 1e-6 or vy < 1e-6:
            continue
        out.append((ww * (x - mx) * (y - my)).sum() / np.sqrt(vx * vy))
    return float(np.mean(out)) if out else None


def neighbour_pairs(hole, box_bgr, cols, rows, col, row, scan_map=None, aspect=1.0, full=None):
    """
    `hole`: resultado de local_search.segment_hole. `box_bgr`: arte retificada. (col, row): célula do buraco.
    Devolve {"rotation", "pairs": [{col, row, rotation: 0, sig}], "corr": [...]} ou {"pairs": []} sem certeza.
    """
    cx0, cy0, side = hole["box"]
    img = cv2.cvtColor(hole["image"], cv2.COLOR_BGR2LAB).astype(np.float32)
    mask = hole["mask"]
    cells = G._rev_cell_descs(box_bgr, cols, rows)
    root = float(np.sqrt(max(0.5, aspect)))
    sx0, sy0 = side / root, side * root          # passo horizontal e vertical em px (corpo × proporção da célula)
    tries = []
    for rot in range(4):
        # giro horário de rot×90° da foto: os vizinhos mudam de lugar e de passo
        im = np.ascontiguousarray(np.rot90(img, -rot))
        h, w = mask.shape[:2]
        pts = {0: (cx0, cy0), 1: (h - 1 - cy0, cx0), 2: (w - 1 - cx0, h - 1 - cy0), 3: (cy0, w - 1 - cx0)}[rot]
        sx, sy = (sx0, sy0) if rot % 2 == 0 else (sy0, sx0)
        items, total, n = [], 0.0, 0
        for dc, dr in NEIGHBOURS:
            c, r = col + dc, row + dr
            if not (0 <= c < cols and 0 <= r < rows):
                continue
            if scan_map and len(scan_map) == cols * rows and scan_map[r * cols + c] != "1":
                continue   # célula que ainda está vazia (ou desconhecida): não é referência
            d, wt = _patch(im, pts[0] + dc * sx, pts[1] + dr * sy, sx, sy)
            cr = _corr(d, cells[r, c], wt)
            if cr is None:
                continue
            items.append((c, r, d, wt, cr))
            total += cr
            n += 1
        tries.append((total, n, items, rot, pts, sx, sy))
    tries.sort(key=lambda t: -t[0])
    best, second = tries[0], tries[1]
    if best[1] < 2 or best[0] - second[0] < MIN_MARGIN * best[1]:
        return {"pairs": []}
    pairs = []
    fim = None
    if full is not None:
        fim = np.ascontiguousarray(np.rot90(full, -best[3]))
    for c, r, d, wt, cr in best[2]:
        if cr < MIN_CORR:
            continue
        arr = np.dstack([np.clip(d, 0, 255), np.clip(wt * 255, 0, 255)]).round().astype(np.uint8)
        pair = {"col": c, "row": r, "rotation": 0, "sig": base64.b64encode(arr.tobytes()).decode("ascii")}
        if fim is not None:
            pair["patch"] = _patch_jpeg(fim, hole["scale"], best[4], best[5], best[6], c - col, r - row, aspect)
        pairs.append(pair)
    return {"rotation": best[3] * 90, "pairs": pairs, "corr": [round(it[4], 2) for it in best[2]]}


PATCH_W = 160


def _patch_jpeg(fim, scale, centre, sx, sy, dc, dr, aspect):
    """Recorte nítido (resolução da foto enviada) da célula vizinha, já na orientação da arte, em JPEG base64."""
    cx, cy = (centre[0] + dc * sx) / scale, (centre[1] + dr * sy) / scale
    w, h = max(8, int(round(sx / scale))), max(8, int(round(sy / scale)))
    crop = cv2.getRectSubPix(fim, (w, h), (float(cx), float(cy)))
    out_h = max(8, int(round(PATCH_W * h / w)))
    crop = cv2.resize(crop, (PATCH_W, out_h), interpolation=cv2.INTER_AREA if w > PATCH_W else cv2.INTER_CUBIC)
    ok, enc = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return base64.b64encode(enc.tobytes()).decode("ascii")
