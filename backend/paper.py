"""
Folha A4 sob as peças: o padrão recomendado para a foto da mesa.

A folha resolve três coisas de uma vez:
  - perspectiva: a foto é endireitada pelo plano da folha (peças vistas de cima, sem distorção);
  - escala: 297 × 210 mm conhecidos → px por mm → tamanho exato de cada peça na foto;
  - cor: o papel é branco, a referência de branco da luz daquela foto (balanço de branco).
Sem folha encontrada, quem chama segue com a foto original.
"""
import cv2
import numpy as np

A4_MM = (297.0, 210.0)
# Resolução do recorte endireitado: até 10 px/mm (A4 com ~3000 px no lado maior), sem ampliar a foto
MAX_PX_PER_MM = 10.0
# A folha precisa ocupar pelo menos esta fração da foto e ter proporção perto de A4 (1,41)
MIN_AREA_FRACTION = 0.12
ASPECT_RANGE = (1.15, 1.75)
# Distância mínima (fração do lado maior) entre os cantos da folha e a borda da foto
BORDER_MARGIN = 0.01
# Diferença máxima de cor (a, b) entre um pixel e a cor típica do papel na foto
PAPER_TINT_TOL = 14.0
# Dentro da folha: pelo menos esta fração é papel (cor uniforme, tolerância abaixo), quase toda numa
# região só (nas fotos reais: folha 58-93% e 99%; peças claras juntas numa mesa escura: 9% e 8%)
PAPER_UNIFORM_TOL = 12.0
PAPER_MIN_FILL = 0.35
PAPER_MIN_CONNECTED = 0.6
# Fundo claro sem a folha inteira: luz mínima (escala 0-255) e tinta máxima (a, b) do fundo
LIGHT_BG_MIN_L = 140.0
LIGHT_BG_MAX_TINT = 20.0
# Branco de referência depois do balanço (abaixo de 255 para não estourar o papel)
WHITE_LEVEL = 235.0
# Ganho máximo por canal no balanço de branco (luz muito colorida ou papel sombreado)
MAX_GAIN = 2.0
# Margem (mm) cortada da borda da folha: sombra da dobra/borda do papel
EDGE_TRIM_MM = 2.0


def find_paper(img_bgr):
    """4 cantos (x, y em px, sentido horário a partir do superior esquerdo) da folha, ou None."""
    h, w = img_bgr.shape[:2]
    s = 1000.0 / max(h, w)
    small = cv2.resize(img_bgr, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else img_bgr.copy()
    s = min(s, 1.0)
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32)
    L = lab[..., 0]
    # Papel: a região clara de cor mais uniforme. A luz pode tingir o papel (lâmpada quente) e deixá-lo
    # cinza (pouca luz), então luz e cor são relativas à própria foto: claro pelo Otsu da luz, e cor
    # perto da cor típica dos pixels claros (a moda, que é o papel quando ele domina a parte clara)
    thr, _ = cv2.threshold(L.astype(np.uint8).reshape(-1, 1), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bright = L > max(thr, 80)
    if bright.sum() < MIN_AREA_FRACTION * bright.size:
        return None
    ab = lab[..., 1:][bright]
    q = np.clip(ab // 4, 0, 63).astype(np.int32)
    mode = np.bincount(q[:, 0] * 64 + q[:, 1], minlength=4096).argmax()
    tint = np.array([mode // 64, mode % 64], np.float32) * 4 + 2
    mask = (bright & (np.linalg.norm(lab[..., 1:] - tint, axis=2) < PAPER_TINT_TOL)).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k)
    n, cc, st, _ = cv2.connectedComponentsWithStats(mask)
    if n < 2:
        return None
    i = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    if st[i, cv2.CC_STAT_AREA] < MIN_AREA_FRACTION * mask.size:
        return None
    # As peças são buracos dentro do papel: o contorno externo (fecho convexo) é a folha
    cnts, _ = cv2.findContours((cc == i).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull = cv2.convexHull(max(cnts, key=cv2.contourArea))
    quad = None
    peri = cv2.arcLength(hull, True)
    for eps in (0.01, 0.02, 0.03, 0.05):
        approx = cv2.approxPolyDP(hull, eps * peri, True)
        if len(approx) == 4:
            quad = approx.reshape(4, 2).astype(np.float32)
            break
    if quad is None:
        quad = cv2.boxPoints(cv2.minAreaRect(hull)).astype(np.float32)
    # Folha cortada pela foto (algum canto na borda): sem os 4 cantos, a escala e a perspectiva não valem
    sh, sw = lab.shape[:2]
    m = BORDER_MARGIN * max(sh, sw)
    if ((quad[:, 0] < m) | (quad[:, 0] > sw - 1 - m) | (quad[:, 1] < m) | (quad[:, 1] > sh - 1 - m)).any():
        return None
    if not _looks_like_paper(lab, quad):
        return None
    quad = _order(quad) / s
    sides = [np.linalg.norm(quad[(j + 1) % 4] - quad[j]) for j in range(4)]
    long_, short = (sides[0] + sides[2]) / 2, (sides[1] + sides[3]) / 2
    aspect = max(long_, short) / max(1.0, min(long_, short))
    if not (ASPECT_RANGE[0] <= aspect <= ASPECT_RANGE[1]):
        return None
    return quad


def _looks_like_paper(lab, quad):
    """
    Confere o quadrilátero: o papel é UMA superfície contínua de cor uniforme que cobre boa parte dele
    (as peças cobrem o resto). Peças claras bem juntas numa mesa escura também formam uma mancha clara,
    mas são muitos pedaços pequenos de cores diferentes.
    """
    inside = np.zeros(lab.shape[:2], np.uint8)
    cv2.fillPoly(inside, [quad.astype(np.int32)], 1)
    sel = inside > 0
    if sel.sum() < 100:
        return False
    L = lab[..., 0]
    ref = np.median(lab[sel & (L >= np.percentile(L[sel], 70))], axis=0)
    paper = sel & (np.linalg.norm((lab - ref) * np.array([0.5, 1.0, 1.0], np.float32), axis=2) < PAPER_UNIFORM_TOL)
    if paper.sum() < PAPER_MIN_FILL * sel.sum():
        return False
    n, _, st, _ = cv2.connectedComponentsWithStats(paper.astype(np.uint8), connectivity=8)
    return n > 1 and st[1:, cv2.CC_STAT_AREA].max() >= PAPER_MIN_CONNECTED * paper.sum()


def _order(pts):
    """Ordena 4 pontos: superior esquerdo, superior direito, inferior direito, inferior esquerdo."""
    c = pts.mean(0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    pts = pts[np.argsort(ang)]  # sentido horário na imagem (y para baixo), começando em ~-180°
    start = int(np.argmin(pts.sum(1)))  # superior esquerdo: menor x + y
    return np.roll(pts, -start, axis=0)


def rectify_paper(img_bgr, quad):
    """
    Endireita a folha (vista de cima), corta a borda e aplica o balanço de branco pelo papel.
    Retorna (imagem, px_por_mm, M) — M leva pontos da foto original para a imagem endireitada.
    """
    sides = [np.linalg.norm(quad[(j + 1) % 4] - quad[j]) for j in range(4)]
    landscape = (sides[0] + sides[2]) >= (sides[1] + sides[3])
    w_mm, h_mm = (A4_MM if landscape else A4_MM[::-1])
    # Não amplia: px/mm limitado pela resolução da própria foto
    density = min((sides[0] + sides[2]) / 2 / w_mm, (sides[1] + sides[3]) / 2 / h_mm)
    ppm = float(min(MAX_PX_PER_MM, density))
    W, H = int(round(w_mm * ppm)), int(round(h_mm * ppm))
    dst = np.array([[0, 0], [W, 0], [W, H], [0, H]], np.float32)
    M = cv2.getPerspectiveTransform(quad.astype(np.float32), dst)
    out = cv2.warpPerspective(img_bgr, M, (W, H), flags=cv2.INTER_AREA if density > ppm else cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_REPLICATE)
    t = int(round(EDGE_TRIM_MM * ppm))
    if t > 0 and W > 4 * t and H > 4 * t:
        out = out[t:H - t, t:W - t]
        M = np.array([[1, 0, -t], [0, 1, -t], [0, 0, 1]], np.float64) @ M
    out, _ = white_balance(out)
    return out, ppm, M


def white_balance(img_bgr):
    """Ganhos por canal para o papel (claro e neutro) ficar branco; as peças recebem a mesma correção."""
    f = img_bgr.astype(np.float32)
    lum = f.mean(2)
    # Papel = os pixels mais claros (as peças cobrem no máximo metade da folha)
    paper = lum >= np.percentile(lum, 55)
    ref = np.median(f[paper], axis=0)
    gains = np.clip(WHITE_LEVEL / np.maximum(ref, 1.0), 1.0 / MAX_GAIN, MAX_GAIN)
    return np.clip(f * gains, 0, 255).astype(np.uint8), gains


def balance_pieces_on_background(img_bgr, pieces):
    """
    Folha (ou mesa clara) ocupando a foto, sem os cantos à vista: o fundo em volta das peças ainda é o
    branco de referência daquela luz. Corrige só os recortes das peças (cor e desenho comparados com
    a caixa), não a foto: a separação já foi feita. Retorna os ganhos BGR aplicados, ou None.
    """
    if not pieces:
        return None
    free = np.ones(img_bgr.shape[:2], np.uint8)
    for p in pieces:
        x, y, w, h = p["bbox"]
        free[y:y + h, x:x + w][p["mask"] > 0] = 0
    free = cv2.erode(free, np.ones((15, 15), np.uint8))
    if free.sum() < 0.2 * free.size:
        return None
    bg = img_bgr[free > 0].astype(np.float32)
    ref = np.median(bg, axis=0)
    lab = cv2.cvtColor(ref.reshape(1, 1, 3).astype(np.uint8), cv2.COLOR_BGR2LAB).reshape(3).astype(np.float32)
    tint = float(np.hypot(lab[1] - 128, lab[2] - 128))
    # Só fundo claro e quase neutro (papel, mesa branca); mesa escura ou de madeira não é referência
    if lab[0] < LIGHT_BG_MIN_L or tint > LIGHT_BG_MAX_TINT:
        return None
    gains = np.clip(ref.mean() / np.maximum(ref, 1.0), 1.0 / MAX_GAIN, MAX_GAIN)
    for p in pieces:
        for key in ("crop", "upright"):
            if p.get(key) is not None:
                p[key] = np.clip(p[key].astype(np.float32) * gains, 0, 255).astype(np.uint8)
    return gains


class TablePhoto:
    """Foto da mesa pronta para segmentar: a folha endireitada (se houver) e o caminho de volta para a foto."""

    def __init__(self, original):
        self.original_size = (original.shape[1], original.shape[0])
        quad = find_paper(original)
        self.on_paper = quad is not None
        if self.on_paper:
            self.image, self.px_per_mm, M = rectify_paper(original, quad)
            self._back = np.linalg.inv(M)
        else:
            self.image, self.px_per_mm, self._back = original, None, None

    def to_original(self, pts):
        """Pontos (x, y) da imagem de trabalho → foto original."""
        pts = np.asarray(pts, np.float64).reshape(-1, 1, 2)
        if self._back is None:
            return pts.reshape(-1, 2)
        return cv2.perspectiveTransform(pts, self._back).reshape(-1, 2)

    def bbox_to_original(self, bbox):
        x, y, w, h = bbox
        pts = self.to_original([[x, y], [x + w, y], [x + w, y + h], [x, y + h]])
        x0, y0 = np.floor(pts.min(0)).astype(int)
        x1, y1 = np.ceil(pts.max(0)).astype(int)
        return [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]
