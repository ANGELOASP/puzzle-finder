"""
Busca local a partir de uma FOTO DO BURACO.

O usuário fotografa de perto o buraco que quer preencher (com as peças vizinhas em volta). Essa foto traz duas
informações que o mapa da caixa não tem:

1. O formato exato do buraco (abas e encaixes de cada lado), medido numa foto bem mais nítida que a do tabuleiro
   inteiro: a silhueta da peça que falta é a do próprio buraco.
2. As cores REAIS das vizinhas junto da borda, da mesma câmera e da mesma luz das fotos das peças: o desenho
   continua de uma peça na outra. Isso dispensa a arte da caixa, cuja cor difere da das fotos (reflexo, tom da
   impressão), que é o maior motivo de erro da busca pela arte.

Para cada peça do banco e cada giro (0/90/180/270): encaixe da silhueta (lados e sobreposição) e continuidade das cores
ao longo da borda. Tudo só compara a foto do buraco com as peças, sem precisar da arte.
"""
import cv2
import numpy as np

from grid_engine import _sides_and_box, rotate_shapes

HOLE_MAX_SIDE = 520          # a foto do buraco é reduzida a isso (o corpo fica com ~140 px: sobra para a comparação)
HOLE_MIN_TOL = 10.0          # tolerância mínima de cor para o "vazio" (Lab ponderado)
N_SECTORS = 32               # a borda é dividida em setores por ângulo em volta do centro do buraco
GAP = 0.02                   # folga (fração do corpo) entre as bordas: a linha escura entre as peças
BAND = 0.07                  # largura (fração do corpo) da faixa de cor comparada de cada lado
W_LAB = np.array([0.5, 1.0, 1.0], np.float32)
SHAPE_PENALTY = 0.6          # custo de cada lado cujo formato não bate (0 a 1 de IoU vale ~1)
ALIGN_BODY = 1.45            # janela de comparação: ALIGN_BODY × o corpo


def _lab(bgr):
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)


class HoleError(Exception):
    """A foto não permite medir o buraco; `args[0]` diz o que o usuário deve fazer."""


def segment_hole(photo_bgr, seed=None):
    """
    Acha o buraco na foto: a região de cor uniforme (mesa, feltro) que contém `seed` (x, y normalizados 0..1; padrão: o
    centro). Devolve dict(image, mask, shapes, box, body) na escala reduzida, ou levanta HoleError.
    """
    h0, w0 = photo_bgr.shape[:2]
    s = min(1.0, HOLE_MAX_SIDE / float(max(h0, w0)))
    img = cv2.resize(photo_bgr, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else photo_bgr
    h, w = img.shape[:2]
    sx, sy = (0.5, 0.5) if seed is None else seed
    cx, cy = int(np.clip(sx, 0, 1) * (w - 1)), int(np.clip(sy, 0, 1) * (h - 1))
    lab = cv2.GaussianBlur(_lab(img), (0, 0), 1.4)
    r0 = max(3, int(0.025 * min(h, w)))
    yy, xx = np.ogrid[:h, :w]
    disc = ((xx - cx) ** 2 + (yy - cy) ** 2) <= r0 * r0
    core = lab[disc]
    ref = np.median(core, 0)
    dist = np.sqrt((((lab - ref) * W_LAB) ** 2).sum(-1))
    spread = float(np.percentile(dist[disc], 90))
    empty = (dist < max(HOLE_MIN_TOL, 2.5 * spread)).astype(np.uint8)
    k = max(3, int(0.012 * min(h, w)) | 1)
    empty = cv2.morphologyEx(empty, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    n, cc = cv2.connectedComponents(empty)
    if cc[cy, cx] == 0:
        raise HoleError("Não achei o buraco: toque no meio dele, na parte vazia da mesa.")
    hole = (cc == cc[cy, cx]).astype(np.uint8)
    hole = cv2.morphologyEx(hole, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    # Preenche manchas dentro do buraco (veio da madeira, sombra de uma peça)
    cnts, _ = cv2.findContours(hole, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        raise HoleError("Não achei o buraco: toque no meio dele, na parte vazia da mesa.")
    hole = np.zeros_like(hole)
    cv2.drawContours(hole, [max(cnts, key=cv2.contourArea)], -1, 1, -1)
    ys, xs = np.nonzero(hole)
    area = hole.sum() / float(h * w)
    if area < 0.01:
        raise HoleError("O buraco ficou pequeno na foto. Chegue mais perto, deixando as peças vizinhas aparecerem.")
    if xs.min() <= 1 or ys.min() <= 1 or xs.max() >= w - 2 or ys.max() >= h - 2:
        raise HoleError("O buraco encosta na borda da foto. Afaste um pouco o celular para as peças em volta aparecerem.")
    mask = (hole * 255).astype(np.uint8)
    shapes, box = _sides_and_box(mask)
    if box is None or shapes is None:
        raise HoleError("Não consegui medir o formato do buraco. Tente de novo, bem de cima e com boa luz.")
    body = box[2]
    ratio = hole.sum() / float(body * body)
    # Um buraco fechado ocupa ~1 corpo (abas e encaixes se compensam); bem mais que isso é uma vizinha vazia junto
    if not (0.6 <= ratio <= 1.5):
        raise HoleError("O buraco parece ligado a outro espaço vazio. A busca local funciona melhor num buraco cercado de peças.")
    return {"image": img, "lab": _lab(img), "mask": mask, "shapes": shapes, "box": box, "body": body,
            "scale": s, "seed": (cx, cy)}


def _sector_ids(shape, center):
    h, w = shape
    yy, xx = np.mgrid[:h, :w]
    ang = np.arctan2(yy - center[1], xx - center[0])
    return ((ang + np.pi) / (2 * np.pi) * N_SECTORS).astype(np.int32) % N_SECTORS


def _ring(mask, inner_gap, width, outside):
    """Faixa junto da borda: fora da máscara (vizinhas) ou dentro dela (a peça)."""
    g, wd = max(1, int(round(inner_gap))), max(2, int(round(width)))
    k = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    m = (mask > 127).astype(np.uint8)
    if outside:
        near, far = cv2.dilate(m, k(g)), cv2.dilate(m, k(g + wd))
        return (far > 0) & (near == 0)
    near, far = cv2.erode(m, k(g)), cv2.erode(m, k(g + wd))
    return (near > 0) & (far == 0)


def _sector_means(lab, ring, sec):
    """(N_SECTORS, 3) média Lab da faixa em cada setor e (N_SECTORS,) nº de pixels."""
    ids = sec[ring]
    px = lab[ring]
    cnt = np.bincount(ids, minlength=N_SECTORS)
    out = np.zeros((N_SECTORS, 3), np.float32)
    for c in range(3):
        out[:, c] = np.bincount(ids, weights=px[:, c], minlength=N_SECTORS) / np.maximum(cnt, 1)
    return out, cnt


class HoleReference:
    """O que da foto do buraco não depende da peça, tudo numa janela de ALIGN_BODY × o corpo em volta do buraco."""

    def __init__(self, hole):
        self.hole = hole
        cx, cy, self.body = hole["box"]
        self.half = int(round(ALIGN_BODY * self.body / 2))
        self.size = 2 * self.half
        x0, y0 = int(round(cx)) - self.half, int(round(cy)) - self.half
        H, W = hole["mask"].shape
        pad = lambda a, v: cv2.copyMakeBorder(a, max(0, -y0), max(0, y0 + self.size - H), max(0, -x0), max(0, x0 + self.size - W), cv2.BORDER_CONSTANT, value=v)
        mask = pad(hole["mask"], 0)
        lab = pad(hole["lab"], (0, 0, 0))
        ox, oy = max(0, x0), max(0, y0)
        self.mask = mask[oy:oy + self.size, ox:ox + self.size]
        self.lab = lab[oy:oy + self.size, ox:ox + self.size]
        self.sec = _sector_ids(self.mask.shape, (self.size / 2, self.size / 2))
        self.ring = _ring(self.mask, GAP * self.body, BAND * self.body, outside=True)
        self.means, self.count = _sector_means(self.lab, self.ring, self.sec)
        self.hole_area = float((self.mask > 127).sum())


def _piece_window(piece, ref):
    """
    A peça endireitada na escala da foto do buraco, recortada na mesma janela (centrada no corpo dela). Devolve
    (máscara, lab) ou None. Os 4 giros saem daqui com np.rot90, sem refazer a escala.
    """
    from grid_engine import body_box
    up, m = piece.get("upright"), piece.get("upright_mask")
    if up is None or m is None:
        return None
    box = body_box(m)
    if box is None:
        return None
    px, py, pside = box
    sc = ref.body / pside
    h, w = m.shape[:2]
    # janela em coordenadas da peça: ref.size / sc px em volta do centro do corpo
    M = np.array([[sc, 0, ref.half - sc * px], [0, sc, ref.half - sc * py]], np.float32)
    size = (ref.size, ref.size)
    mask = cv2.warpAffine(m, M, size, flags=cv2.INTER_NEAREST)
    lab = cv2.warpAffine(_lab(up), M, size, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return mask, lab


def edge_cost(ref, piece_mask, piece_lab):
    """
    Continuidade das cores: diferença, setor a setor, entre a faixa das vizinhas (fora do buraco) e a faixa da borda da peça
    (dentro dela). O desvio médio de luz entre as duas fotos sai (a mediana da diferença); o que sobra é o desenho que
    deveria continuar. Média dos 80% melhores setores: a sombra de uma vizinha ou um pedaço sem leitura não decide.
    """
    ring_p = _ring(piece_mask, GAP * ref.body, BAND * ref.body, outside=False)
    pm, pc = _sector_means(piece_lab, ring_p, ref.sec)
    ok = (ref.count >= 8) & (pc >= 8)
    if ok.sum() < N_SECTORS // 2:
        return None
    d = ref.means[ok] - pm[ok]
    off = np.median(d, axis=0)
    r = np.sqrt((((d - off) * W_LAB) ** 2).sum(-1))
    r.sort()
    keep = max(4, int(0.8 * len(r)))
    edge_cost.last_offset = off
    return float(r[:keep].mean())


def shape_iou(ref, piece_mask):
    a = ref.mask > 127
    b = piece_mask > 127
    union = (a | b).sum()
    return float((a & b).sum() / union) if union else 0.0


SHORTLIST = 48               # peças que passam da silhueta para a comparação de cores
MISS_SOFT = 0.06             # o formato dos lados da peça solta pode estar errado: pesa pouco na 1ª etapa


def search(hole, pieces, top_k=10):
    """
    Ordena as peças pelo encaixe no buraco. Devolve lista (melhor primeiro) de dict(index, rotation, score, iou, edge,
    shape_ok): `score` 0..1 (maior é melhor), `shape_ok` False se algum lado conhecido do buraco não bate com a peça
    naquele giro.

    Duas etapas: (1) a sobreposição da silhueta com o buraco, em todos os giros de todas as peças (barata e não depende de
    medir os lados da peça solta, que às vezes erra); (2) com as SHORTLIST melhores, a continuidade das cores da borda.
    """
    from grid_engine import side_shapes
    ref = HoleReference(hole)
    hs = {s: v for s, v in hole["shapes"].items() if v in ("tab", "blank", "flat")}
    stage1 = []
    for i, piece in enumerate(pieces):
        win = _piece_window(piece, ref)
        if win is None:
            continue
        m0, l0 = win
        ps = side_shapes(piece.get("upright_mask"))
        rots = []
        for rot in (0, 90, 180, 270):
            k = (rot // 90) % 4
            mask = m0 if k == 0 else np.rot90(m0, -k).copy()
            miss = 0
            if ps and hs:
                rs = rotate_shapes(ps, rot)
                miss = sum(1 for side in hs if rs.get(side) != hs[side])
            rots.append((rot, k, mask, shape_iou(ref, mask), miss))
        best_iou = max(r[3] - MISS_SOFT * r[4] for r in rots)
        stage1.append((best_iou, i, l0, rots))
    stage1.sort(key=lambda t: -t[0])
    rows = []
    for _, i, l0, rots in stage1[:SHORTLIST]:
        best = None
        for rot, k, mask, iou, miss in rots:
            lab = l0 if k == 0 else np.rot90(l0, -k).copy()
            e = edge_cost(ref, mask, lab)
            if e is None:
                continue
            cost = e / 10.0 + (1.0 - iou) * 2.0 + SHAPE_PENALTY * miss
            if best is None or cost < best["cost"]:
                best = {"index": i, "rotation": rot, "cost": cost, "iou": iou, "edge": e, "shape_miss": miss,
                        "offset": edge_cost.last_offset.copy()}
        if best:
            rows.append(best)
    rows.sort(key=lambda r: r["cost"])
    if not rows:
        return []
    c1 = rows[0]["cost"]
    c2 = rows[1]["cost"] if len(rows) > 1 else c1 * 2
    out = []
    for j, r in enumerate(rows[:top_k]):
        # Nota relativa: 1 = muito melhor que a 2ª opção; as demais, quão perto ficaram da 1ª
        if j == 0:
            score = float(np.clip((c2 - c1) / max(c2, 1e-6) * 4 + 0.5, 0, 1))
        else:
            score = float(np.clip(0.5 - (r["cost"] - c1) / max(c1, 1e-6), 0, 1))
        out.append({**r, "score": score, "shape_ok": r["shape_miss"] == 0})
    return out


def render_fit(hole, piece, rotation, offset=None, size=320):
    """
    Prévia do encaixe: a foto do buraco com a peça desenhada dentro dele, no giro encontrado (BGR, `size` px de lado).
    A luz da peça é aproximada da luz da foto do buraco (o mesmo desvio medido na comparação de cores), e o contorno do
    buraco fica traçado: se for a peça certa, o desenho continua por cima da linha.
    """
    ref = HoleReference(hole)
    up, m = piece["upright"], piece["upright_mask"]
    from grid_engine import body_box
    px, py, pside = body_box(m)
    sc = ref.body / pside
    M = np.array([[sc, 0, ref.half - sc * px], [0, sc, ref.half - sc * py]], np.float32)
    win = (ref.size, ref.size)
    mask = cv2.warpAffine(m, M, win, flags=cv2.INTER_NEAREST)
    lab = cv2.warpAffine(_lab(up), M, win, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    k = (rotation // 90) % 4
    if k:
        mask, lab = np.rot90(mask, -k).copy(), np.rot90(lab, -k).copy()
    if offset is not None:
        lab = lab + np.asarray(offset, np.float32)
    piece_bgr = cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
    # janela da foto do buraco com um pouco mais de contexto que a de comparação
    cx, cy, _ = hole["box"]
    half = int(round(1.05 * ref.half))
    H, W = hole["image"].shape[:2]
    x0, y0 = int(round(cx)) - half, int(round(cy)) - half
    pad = lambda a: cv2.copyMakeBorder(a, half, half, half, half, cv2.BORDER_REPLICATE)
    base = pad(hole["image"])[y0 + half:y0 + 3 * half, x0 + half:x0 + 3 * half].copy()
    # a peça entra na janela de comparação, que fica centrada na do contexto
    o = half - ref.half
    roi = base[o:o + ref.size, o:o + ref.size]
    mm = (mask > 127)
    roi[mm] = piece_bgr[mm]
    full = pad(hole["mask"])[y0 + half:y0 + 3 * half, x0 + half:x0 + 3 * half]
    cnts, _ = cv2.findContours((full > 127).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(base, cnts, -1, (255, 255, 255), 1, cv2.LINE_AA)
    return cv2.resize(base, (size, size), interpolation=cv2.INTER_AREA if base.shape[0] > size else cv2.INTER_CUBIC)


def draw_hole(hole, size=320):
    """A foto do buraco com o contorno e o formato medido (T = aba, E = encaixe, R = reto) de cada lado, para conferir."""
    img = hole["image"].copy()
    cnts, _ = cv2.findContours((hole["mask"] > 127).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(img, cnts, -1, (80, 230, 120), 2, cv2.LINE_AA)
    cx, cy, b = hole["box"]
    letters = {"tab": "T", "blank": "E", "flat": "R", None: "?"}
    pos = {"top": (cx, cy - b * 0.72), "bottom": (cx, cy + b * 0.72), "left": (cx - b * 0.72, cy), "right": (cx + b * 0.72, cy)}
    for side, (x, y) in pos.items():
        cv2.putText(img, letters.get(hole["shapes"].get(side)), (int(x) - 8, int(y) + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(img, letters.get(hole["shapes"].get(side)), (int(x) - 8, int(y) + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 1, cv2.LINE_AA)
    s = size / float(max(img.shape[:2]))
    return cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
