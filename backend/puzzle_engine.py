import cv2
import numpy as np

# Rotações horárias testadas: (graus, código do cv2.rotate)
ROTATIONS = [
    (0, None),
    (90, cv2.ROTATE_90_CLOCKWISE),
    (180, cv2.ROTATE_180),
    (270, cv2.ROTATE_90_COUNTERCLOCKWISE),
]

# Lado (px) para o qual a peça na caixa é normalizada antes da comparação
BOX_PIECE_SIDE = 64
# Fração central da peça usada como "miolo" (fica dentro do corpo mesmo com encaixes/abas)
CORE_FRACTION = 0.55
# Razões testadas entre o lado do bbox da peça na mesa e o lado da peça na caixa (abas aumentam o bbox)
BBOX_TO_BODY_RATIOS = (1.0, 1.2, 1.4)
# Sem a quantidade de peças, assume 500 e varre uma faixa maior de escalas (cobre ~150 a ~2000 peças)
DEFAULT_TOTAL_PIECES = 500
UNKNOWN_COUNT_RATIOS = (0.6, 0.72, 0.86, 1.0, 1.2, 1.4, 1.7, 2.0, 2.4)

# Desvio-padrão de luminância abaixo do qual o miolo é considerado liso demais para comparar
MIN_TEXTURE_STD = 8.0

# Limiares de confiança (calibrados em bench sintético: ~95% de acertos travam, ~7% de falsos
# travamentos com a peça ausente). Fotos reais pontuam menos que o sintético: ajuste aqui se o
# scanner nunca travar ou travar demais.
MIN_VISUAL_SCORE = 0.85
MIN_VISUAL_MARGIN = 0.05
MIN_SHAPE_SIMILARITY = 0.80
MIN_SHAPE_MARGIN = 0.05


# Lado (px) da miniatura usada para estimar o fundo da mesa
BG_SIDE = 500.0
# Suavização da máscara de cada peça (σ como fração do lado do corpo)
MASK_SMOOTH = 0.03
# Corpo (px) abaixo do qual a inclinação é medida pela colinearidade, numa máscara ampliada até SMALL_BODY_UPSCALE
SMALL_BODY = 80.0
SMALL_BODY_UPSCALE = 120.0
# Lado (px) da 1ª passada, que só mede o tamanho das peças
FIRST_PASS_SIDE = 1200.0
# Cor pesa mais que luz: reflexos mudam a luminância, peças mudam a cor
LAB_WEIGHTS = (1.0, 1.4, 1.4)


# Luminância (escala 0-255 do OpenCV) abaixo/acima da qual a mesa é "escura"/"clara"
DARK_TABLE_L, LIGHT_TABLE_L = 70.0, 140.0
# Peso da luz quando ela muda no sentido "errado": numa mesa escura nenhuma peça é mais escura que o
# fundo (é reflexo/sombra do vidro); numa mesa clara, nenhuma é mais clara (é brilho)
WRONG_WAY_L_WEIGHT = 0.3
# Diferença máxima de tom (a, b ponderados) para um escurecimento numa mesa clara contar como sombra
SHADOW_MAX_AB = 8.0
SHADOW_L_WEIGHT = 0.15
# Sombra escurece até esta fração da luz do fundo (nas fotos reais: ~0,85); abaixo disso é peça
SHADOW_MIN_RATIO = 0.55


def _lab_dist(a, b):
    """Distância de cor pixel a pixel entre `a` e o fundo `b`, com a luz pesando pouco no sentido impossível para uma peça."""
    dl = a[..., 0] - b[..., 0]
    ab2 = ((a[..., 1] - b[..., 1]) * LAB_WEIGHTS[1]) ** 2 + ((a[..., 2] - b[..., 2]) * LAB_WEIGHTS[2]) ** 2
    light = b[..., 0] > LIGHT_TABLE_L
    # Sombra numa mesa clara: escurece um pouco, sem mudar o tom do fundo (a luz da sombra puxa um
    # pouco o tom: pesa só metade). Peça cinza-escura escurece muito mais e não entra aqui
    shadow = light & (dl < 0) & (a[..., 0] > SHADOW_MIN_RATIO * b[..., 0]) & (ab2 < SHADOW_MAX_AB ** 2)
    wrong = ((b[..., 0] < DARK_TABLE_L) & (dl < 0)) | (light & (dl > 0))
    wl = np.where(shadow, np.float32(SHADOW_L_WEIGHT), np.where(wrong, np.float32(WRONG_WAY_L_WEIGHT), np.float32(1.0)))
    return np.sqrt((dl * wl) ** 2 + ab2 * np.where(shadow, np.float32(0.25), np.float32(1.0)))


def _masked_blur(img, mask, sigma):
    """Média gaussiana só dos pixels de `mask`; onde não há nenhum por perto, usa uma escala 4× maior."""
    m = mask.astype(np.float32)
    num = cv2.GaussianBlur(img * m[..., None], (0, 0), sigma)
    den = cv2.GaussianBlur(m, (0, 0), sigma)
    out = num / np.maximum(den, 1e-6)[..., None]
    weak = den < 0.05
    if weak.any():
        num2 = cv2.GaussianBlur(img * m[..., None], (0, 0), sigma * 4)
        den2 = cv2.GaussianBlur(m, (0, 0), sigma * 4)
        out[weak] = (num2 / np.maximum(den2, 1e-6)[..., None])[weak]
    return out


def _tile_modes(lab_small, tile):
    """Cor mais comum de cada bloco de `tile` px, com mediana 3×3 entre blocos para descartar blocos tomados por uma peça."""
    sh, sw = lab_small.shape[:2]
    t = max(8, int(tile))
    gy, gx = int(np.ceil(sh / t)), int(np.ceil(sw / t))
    q = (lab_small // 8).astype(np.int32)
    key = (q[..., 0] * 32 + q[..., 1]) * 32 + q[..., 2]
    modes = np.zeros((gy, gx, 3), np.float32)
    for i in range(gy):
        for j in range(gx):
            blk = key[i * t:(i + 1) * t, j * t:(j + 1) * t].ravel()
            vals, cnt = np.unique(blk, return_counts=True)
            sel = lab_small[i * t:(i + 1) * t, j * t:(j + 1) * t].reshape(-1, 3)[blk == vals[np.argmax(cnt)]]
            modes[i, j] = sel.mean(0)
    modes = np.dstack([cv2.medianBlur(np.clip(modes[..., c], 0, 255).astype(np.uint8), 3) for c in range(3)])
    return cv2.resize(modes.astype(np.float32), (sw, sh), interpolation=cv2.INTER_LINEAR)


def _body_radius(fg, dt):
    """Mediana, ponderada pela área, do maior raio inscrito de cada mancha da máscara."""
    n, cc, st, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
    if n < 2:
        return 3.0
    peak = np.zeros(n, np.float32)
    np.maximum.at(peak, cc.ravel(), dt.ravel())
    r, a = peak[1:], st[1:, cv2.CC_STAT_AREA].astype(np.float64)
    x, y, w, h = (st[1:, i] for i in range(4))
    # O que encosta na borda da foto (chão, parede, peças cortadas) não serve de referência
    inner = (x > 0) & (y > 0) & (x + w < fg.shape[1]) & (y + h < fg.shape[0])
    keep = (r > 1.5) & inner if (inner & (r > 1.5)).any() else r > 1.5
    if not keep.any():
        return 3.0
    r, a = r[keep], a[keep]
    order = np.argsort(r)
    cum = np.cumsum(a[order])
    return float(max(3.0, r[order][np.searchsorted(cum, cum[-1] / 2)]))


def _count_inside(inner, outer, n_outer):
    """Quantas regiões de `inner` caem em cada região de `outer` (cada interna está toda dentro de uma externa)."""
    idx = np.flatnonzero(inner)
    owner = np.zeros(int(inner.max()) + 1, np.int64)
    owner[inner.flat[idx]] = outer.flat[idx]
    return np.bincount(owner[1:], minlength=n_outer).astype(np.int32)


def _relabel(lab):
    """Rótulos consecutivos 0..k (0 continua sendo fundo), sem ordenar a imagem toda."""
    present = np.zeros(int(lab.max()) + 1, bool)
    present[lab.ravel()] = True
    present[0] = True
    lut = (np.cumsum(present) - 1).astype(np.int32)
    return lut[lab]


def _collinear_angle(mask):
    """
    Inclinação (graus, -45..45, sentido de getRotationMatrix2D) pela colinearidade: gira o contorno e
    conta quantos pontos caem na mesma linha e na mesma coluna (soma dos quadrados dos histogramas).
    Os lados retos do corpo se empilham em poucas linhas/colunas só no ângulo certo; abas e encaixes
    são arcos e se espalham em qualquer ângulo. É uma transformada de Hough restrita a duas direções
    perpendiculares.
    """
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return 0.0
    p = max(cnts, key=cv2.contourArea).reshape(-1, 2).astype(np.float64)
    if len(p) < 20:
        return 0.0
    p -= p.mean(0)

    def best(ts):
        # Todas as rotações de uma vez: um histograma por ângulo, num único bincount
        a = np.radians(ts)[:, None]
        x = p[:, 0] * np.cos(a) - p[:, 1] * np.sin(a)
        y = p[:, 0] * np.sin(a) + p[:, 1] * np.cos(a)
        scores = np.zeros(len(ts))
        for v in (x, y):
            b = np.round(v - v.min(1, keepdims=True)).astype(np.int64)
            span = int(b.max()) + 1
            h = np.bincount((b + np.arange(len(ts))[:, None] * span).ravel(), minlength=len(ts) * span)
            scores += (h.reshape(len(ts), span).astype(np.float64) ** 2).sum(1)
        return float(ts[int(np.argmax(scores))])

    t0 = best(np.arange(-45.0, 45.0, 2.0))
    t = best(np.arange(t0 - 2.0, t0 + 2.01, 0.25))
    return ((t + 45.0) % 90.0) - 45.0


def _corner_score(mask, angle):
    """
    Quão bem a máscara endireitada por `angle` tem os 4 cantos retos de um corpo de peça: cheia logo
    por dentro de cada canto e vazia logo por fora, na diagonal (abas e encaixes ficam no meio dos lados).
    """
    h, w = mask.shape
    m = mask.astype(np.uint8)
    M = cv2.getRotationMatrix2D((w / 2, h / 2), -angle, 1.0)
    side = int(np.ceil(np.hypot(h, w)))
    M[0, 2] += (side - w) / 2
    M[1, 2] += (side - h) / 2
    r = cv2.warpAffine(m, M, (side, side), flags=cv2.INTER_NEAREST) > 0
    ys, xs = np.nonzero(r)
    if len(xs) < 50:
        return 0.0
    cx, cy, half = xs.mean(), ys.mean(), 0.5 * np.sqrt(len(xs))
    d = max(2, int(round(0.12 * half)))
    score = 0.0
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        # Canto do corpo: o ponto mais avançado da máscara na direção diagonal, perto do canto esperado
        x0, y0 = int(round(cx + sx * half)), int(round(cy + sy * half))
        win = r[max(0, y0 - 2 * d):y0 + 2 * d + 1, max(0, x0 - 2 * d):x0 + 2 * d + 1]
        if not win.any():
            continue
        wy, wx = np.nonzero(win)
        far = np.argmax(wx * sx + wy * sy)
        px, py = max(0, x0 - 2 * d) + wx[far], max(0, y0 - 2 * d) + wy[far]
        inside = r[min(py, py - sy * d):max(py, py - sy * d) + 1, min(px, px - sx * d):max(px, px - sx * d) + 1]
        outside = r[min(py + sy, py + sy * d):max(py + sy, py + sy * d) + 1, min(px + sx, px + sx * d):max(px + sx, px + sx * d) + 1]
        score += (inside.mean() if inside.size else 0.0) - (outside.mean() if outside.size else 0.0)
    return score / 4


def _rotate(img, code):
    return img if code is None else cv2.rotate(img, code)


class PuzzleEngine:

    def segment_table_pieces(self, table_img_bgr, max_area_fraction=0.25):
        """
        Separa as peças soltas do fundo da mesa, mesmo com centenas de peças e reflexos.
        - Fundo LOCAL estimado só com pixels de fundo (mesa coberta de peças, reflexos, vidro escuro
          ou mesa clara): ver _foreground.
        - Watershed sobre a transformada de distância: separa peças encostadas ou ligadas por brilho.
        """
        h, w = table_img_bgr.shape[:2]
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

        def clean(m):
            m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel, iterations=1)
            return cv2.morphologyEx(m, cv2.MORPH_CLOSE, kernel, iterations=1)

        # 1ª passada em escala genérica só para medir as peças; a 2ª ajusta o modelo de fundo ao
        # tamanho delas (acompanha reflexos de borda nítida sem confundir uma peça grande com a mesa)
        s1 = min(1.0, FIRST_PASS_SIDE / max(h, w))
        small = cv2.resize(table_img_bgr, None, fx=s1, fy=s1, interpolation=cv2.INTER_AREA) if s1 < 1 else table_img_bgr
        fg = clean(self._foreground(small))
        radius = _body_radius(fg, cv2.distanceTransform(fg, cv2.DIST_L2, 5)) / s1
        fg = clean(self._foreground(table_img_bgr, piece_size=4.0 * radius))
        # O limiar baixo (que pega abas de cor parecida com a mesa) também pega o halo de 1 px de
        # transição peça/fundo, que mancharia a comparação com a caixa
        fg = cv2.erode(fg, kernel)

        # Raio do corpo pelo pico da transformada de distância de cada mancha: vale também dentro de
        # uma "corrente" de peças encostadas, onde a área mediana não serve. Mediana ponderada pela
        # área: fiapos de reflexo e pontas de abas são muitos, mas pequenos
        dt_all = cv2.distanceTransform(fg, cv2.DIST_L2, 5)
        radius = _body_radius(fg, dt_all)
        # Partes do desenho da cor da mesa viram furos dentro da peça: furos menores que o miolo de uma
        # peça são tapados (os vãos entre peças vizinhas tocam o fundo aberto e ficam)
        _, holes, st_h, _ = cv2.connectedComponentsWithStats((fg == 0).astype(np.uint8), connectivity=4)
        small_holes = np.where(st_h[:, cv2.CC_STAT_AREA] < 2.0 * radius * radius)[0]
        small_holes = small_holes[small_holes > 0]
        if small_holes.size:
            fg[np.isin(holes, small_holes)] = 255
        # Riscos e reflexos finos no vidro ligam peças vizinhas: uma abertura de ~0,3 r os corta
        # sem estrangular o pescoço das abas (≈ 0,8 r)
        k = int(max(3, round(0.3 * radius))) | 1
        fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        dt_all = cv2.distanceTransform(fg, cv2.DIST_L2, 5)

        # Um miolo por peça: a região bem dentro do corpo (dt > 0,75 r). Uma peça com dois encaixes
        # opostos pode ter o miolo partido na "cintura"; partes a menos de ~0,8 r umas das outras são
        # a mesma peça (miolos de peças vizinhas ficam a ≥ 1,5 r)
        strong = (dt_all > 0.75 * radius).astype(np.uint8)
        g = int(max(3, round(0.8 * radius))) | 1
        merged = cv2.dilate(strong, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (g, g))) & (fg > 0)
        n_m, merged_lab = cv2.connectedComponents(merged.astype(np.uint8))
        _, strong_lab = cv2.connectedComponents(strong)
        # ...mas uma mancha de brilho larga também tem miolo e, unida, "cola" os miolos de todas as
        # peças em volta: grupos de mais de 3 partes voltam a ser miolos separados
        parts = _count_inside(strong_lab, merged_lab, n_m)
        crowded = np.isin(merged_lab, np.where(parts > 3)[0])
        core_lab = _relabel(np.where(crowded, np.where(strong > 0, strong_lab + n_m, 0), merged_lab))
        cores = core_lab > 0

        n1, cc1, st1, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
        regions = fg.copy()
        n_cores = _count_inside(core_lab, cc1, n1)
        # Área típica de UMA peça, medida nas manchas de um miolo só (as abas mudam muito a razão
        # área/raio entre modelos de peça)
        x0, y0, ww, hh = (st1[:, i] for i in range(4))
        inner = (x0 > 0) & (y0 > 0) & (x0 + ww < w) & (y0 + hh < h)
        singles = st1[1:, cv2.CC_STAT_AREA][(n_cores[1:] == 1) & inner[1:]]
        single_area = float(np.median(singles)) if singles.size >= 5 else 7.0 * radius * radius

        # Só manchas com 2+ miolos E bem maiores que uma peça passam pelo watershed (dividir as outras
        # cortaria peças com cintura)
        big_ids = np.where((n_cores >= 2) & (st1[:, cv2.CC_STAT_AREA] > 1.5 * single_area))[0]
        big_ids = big_ids[big_ids > 0]
        if big_ids.size:
            big = np.isin(cc1, big_ids)
            fg_big = (big & (fg > 0)).astype(np.uint8) * 255
            markers = np.where(big, core_lab, 0).astype(np.int32) + 1
            markers[(fg_big > 0) & (markers == 1)] = 0
            ws = cv2.watershed(cv2.cvtColor(fg_big, cv2.COLOR_GRAY2BGR), markers)
            regions[big & (ws == -1)] = 0  # linhas de corte entre as peças grudadas
            # Brilho e reflexos colados a uma peça entram na região dela: nenhuma parte de peça fica
            # a mais de ~2,3 r do miolo (ponta da aba), o resto é descartado
            far = cv2.distanceTransform((cores == 0).astype(np.uint8), cv2.DIST_L2, 5) > 2.3 * radius
            regions[big & far] = 0

        # Cada região vira uma peça
        n, cc, stats, centroids = cv2.connectedComponentsWithStats((regions > 0).astype(np.uint8), connectivity=4)
        areas = stats[1:, cv2.CC_STAT_AREA]
        if not len(areas):
            return []
        min_area = max(30.0, single_area * 0.3)
        max_area = min(h * w * max_area_fraction, single_area * 4)

        pieces = []
        for i in range(1, n):
            x, y, bw, bh, area = stats[i]
            if not (min_area < area < max_area):
                continue
            mask = (cc[y:y + bh, x:x + bw] == i).astype(np.uint8) * 255
            # Borda serrilhada (ruído/JPEG) engana a inclinação e o formato dos lados: suaviza na
            # escala da peça (contornos de aba e encaixe são bem maiores que isso)
            sig = max(1.0, MASK_SMOOTH * np.sqrt(area))
            mask = ((cv2.GaussianBlur(mask, (0, 0), sig) > 127) & (mask > 0)).astype(np.uint8) * 255 \
                if area > 400 else mask
            cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            if not cnts:
                continue
            cnt = max(cnts, key=cv2.contourArea) + np.array([[x, y]])
            crop = table_img_bgr[y:y + bh, x:x + bw]
            upright, upright_mask = self._deskew_local(crop, mask)
            pieces.append({
                "id": len(pieces) + 1,
                "bbox": (int(x), int(y), int(bw), int(bh)),
                "centroid": (int(round(centroids[i][0])), int(round(centroids[i][1]))),
                "crop": crop,
                "mask": mask,
                "contour": cnt,
                "area": float(area),
                "upright": upright,
                "upright_mask": upright_mask,
            })
        return pieces

    def _foreground(self, img_bgr, piece_size=None):
        """
        Máscara peça × fundo.
        O fundo é estimado só com pixels que já parecem fundo (convolução normalizada), começando pela
        cor mais comum de cada bloco: a mesa é uma cor só e as peças são muitas, então mesmo com mais da
        metade da mesa coberta o fundo continua sendo a moda. Algumas passadas acompanham reflexos e
        sombras sem que as peças "contaminem" o fundo (o que a mediana simples fazia em fotos de perto).
        """
        h, w = img_bgr.shape[:2]
        lab = cv2.cvtColor(cv2.GaussianBlur(img_bgr, (3, 3), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
        s_ = BG_SIDE / max(h, w)
        small = cv2.resize(lab, None, fx=s_, fy=s_, interpolation=cv2.INTER_AREA)
        if piece_size:  # blocos de ~3 peças, fundo suavizado na escala de ~1 peça
            bg = _tile_modes(small, tile=3.0 * piece_size * s_)
            sigma = max(1.5, piece_size * s_)
        else:
            bg = _tile_modes(small, tile=max(small.shape[:2]) / 14.0)
            sigma = max(small.shape[:2]) * 0.03
        bgm = _lab_dist(small, bg) < 20
        thr = 8.0
        for _ in range(4):
            bg = _masked_blur(small, bgm, sigma)
            d = _lab_dist(small, bg)
            noise = float(np.percentile(d[bgm], 90)) if bgm.any() else 5.0
            thr = max(8.0, 2.5 * noise)
            bgm = d < thr * 0.5
        bg = cv2.resize(bg, (w, h), interpolation=cv2.INTER_LINEAR)
        fg = (_lab_dist(lab, bg) > thr).astype(np.uint8) * 255
        return fg

    def _deskew_local(self, crop_bgr, crop_mask):
        """_deskew a partir do recorte da peça (evita máscaras do tamanho da foto)."""
        pad = 6
        img = cv2.copyMakeBorder(crop_bgr, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
        m = cv2.copyMakeBorder(crop_mask, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        if not cnts:
            return None, None
        return self._deskew(img, m, max(cnts, key=cv2.contourArea))

    def _body_angle(self, mask):
        """
        Inclinação do corpo da peça (graus, -45..45, mesmo sentido de getRotationMatrix2D).
        Peça grande: direção do gradiente da máscara (_gradient_angle, erro ~0,1°). Peça pequena
        (corpo < SMALL_BODY px, comum na foto da mesa inteira): o serrilhado engana o gradiente e as
        abas pesam demais; usa o ângulo em que os trechos retos do contorno ficam COLINEARES (os dois
        pedaços de cada lado do corpo, um de cada lado da aba), numa máscara ampliada e suavizada.
        """
        m = (mask > 127).astype(np.float32)
        body = float(np.sqrt(m.sum()))
        if body >= SMALL_BODY or body < 6:
            return self._gradient_angle(mask)
        s = SMALL_BODY_UPSCALE / body
        up = cv2.resize(cv2.GaussianBlur(m, (0, 0), 0.8), None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC) > 0.5
        # Os dois métodos erram em peças diferentes (abas grandes, contorno serrilhado): fica o ângulo
        # que deixa os 4 cantos retos do corpo mais nítidos
        cands = [_collinear_angle(up), self._gradient_angle(up.astype(np.uint8) * 255)]
        return max(cands, key=lambda a: _corner_score(up, a))

    def _gradient_angle(self, mask):
        """
        Inclinação do corpo da peça (graus, -45..45, mesmo sentido de getRotationMatrix2D).
        Histograma (módulo 90°) da direção do gradiente da máscara suavizada, pesado pela intensidade:
        os lados retos do corpo formam um pico; abas e encaixes são arcos e se espalham.
        (minAreaRect se inclina para acompanhar as abas; projeções de pontos têm viés a 45°.)
        """
        # σ=3 apaga o serrilhado dos pixels (que puxaria a direção para 0°/90°)
        m = cv2.GaussianBlur((mask > 127).astype(np.float32), (0, 0), 3.0)
        gx = cv2.Sobel(m, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(m, cv2.CV_32F, 0, 1, ksize=3)
        mag = np.hypot(gx, gy)
        sel = mag > mag.max() * 0.2
        ang = np.degrees(np.arctan2(gy[sel], gx[sel])) % 90.0
        w = mag[sel]
        hist, _ = np.histogram(ang, bins=180, range=(0, 90), weights=w)
        # suaviza circularmente (0° e 90° são a mesma direção)
        k = np.exp(-0.5 * (np.arange(-6, 7) / 2.0) ** 2)
        hist = np.convolve(np.concatenate([hist[-6:], hist, hist[:6]]), k, mode="same")[6:-6]
        peak = (np.argmax(hist) + 0.5) * 0.5
        # refina com a média (período 90°) das direções a até 6° do pico
        d = (ang - peak + 45) % 90 - 45
        near = np.abs(d) < 6
        a = (peak + (np.average(d[near], weights=w[near]) if near.any() else 0.0)) % 90
        a = a - 90.0 if a > 45 else a
        # gradiente medido com y para baixo: inclinação +a na imagem = -a em getRotationMatrix2D
        return -a

    def _deskew(self, img_bgr, mask, contour):
        """Recorta a peça (imagem e máscara) alinhada aos eixos pelo corpo, removendo a inclinação de até 45°."""
        x, y, w, h = cv2.boundingRect(contour)
        if w < 4 or h < 4:
            return None, None
        pad = 4
        y1, y2, x1b, x2b = max(0, y - pad), y + h + pad, max(0, x - pad), x + w + pad
        angle = self._body_angle(mask[y1:y2, x1b:x2b])
        cx, cy = x + w / 2.0, y + h / 2.0
        M = cv2.getRotationMatrix2D((cx, cy), -angle, 1.0)
        # Caixa da máscara girada → recorte justo
        pts = cv2.transform(contour.reshape(-1, 1, 2).astype(np.float32), M).reshape(-1, 2)
        x1, y1 = pts.min(0)
        x2, y2 = pts.max(0)
        M[0, 2] -= x1
        M[1, 2] -= y1
        size = (int(np.ceil(x2 - x1)) + 1, int(np.ceil(y2 - y1)) + 1)
        return (cv2.warpAffine(img_bgr, M, size, flags=cv2.INTER_LINEAR),
                cv2.warpAffine(mask, M, size, flags=cv2.INTER_NEAREST))

    def extract_box_patch(self, box_bgr, x_ratio, y_ratio, total_pieces=None):
        """
        Recorta da imagem da caixa a região em volta do ponto tocado.
        O tamanho de uma peça na caixa é estimado pela quantidade total de peças.
        Retorna a região já normalizada para que uma peça tenha BOX_PIECE_SIDE px.
        """
        h, w = box_bgr.shape[:2]
        total = total_pieces if total_pieces and total_pieces > 0 else DEFAULT_TOTAL_PIECES
        side = max(8.0, (h * w / float(total)) ** 0.5)

        # Janela de ~2,5 peças: comporta o miolo da peça mesmo com o toque fora do centro exato
        half = side * 1.25
        cx, cy = x_ratio * w, y_ratio * h
        x1, y1 = int(max(0, cx - half)), int(max(0, cy - half))
        x2, y2 = int(min(w, cx + half)), int(min(h, cy + half))
        region = box_bgr[y1:y2, x1:x2]
        if region.size == 0:
            return None

        scale = BOX_PIECE_SIDE / side
        interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
        return {
            "image": cv2.resize(region, None, fx=scale, fy=scale, interpolation=interp),
            # Ponto tocado dentro da região normalizada (não é o centro quando a região encosta na borda)
            "tap": ((cx - x1) * scale, (cy - y1) * scale),
            "ratios": BBOX_TO_BODY_RATIOS if total_pieces and total_pieces > 0 else UNKNOWN_COUNT_RATIOS,
        }

    def extract_slot_from_board(self, board_bgr, cx, cy, roi_radius=110):
        """
        Extrai o contorno geométrico do buraco vazio no tabuleiro montado.
        Retorna (slot_contour, roi_annotated)
        """
        h_board, w_board = board_bgr.shape[:2]
        x1 = max(0, cx - roi_radius)
        y1 = max(0, cy - roi_radius)
        x2 = min(w_board, cx + roi_radius)
        y2 = min(h_board, cy + roi_radius)

        roi = board_bgr[y1:y2, x1:x2].copy()
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        blurred = cv2.bilateralFilter(gray, 9, 75, 75)

        # Encontra bordas entre peças vizinhas e o buraco
        edges = cv2.Canny(blurred, 30, 90)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        dilated = cv2.dilate(edges, kernel, iterations=1)

        _, bin_thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        combined = dilated | bin_thresh

        contours, _ = cv2.findContours(combined, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

        seed = (float(cx - x1), float(cy - y1))
        max_area = roi.shape[0] * roi.shape[1] * 0.85

        # Prefere o MENOR contorno que contém o ponto tocado (o próprio buraco, não a região em volta);
        # se nenhum contém, aceita o mais próximo a até 15 px.
        best_cnt, best_area = None, float('inf')
        near_cnt, near_dist = None, 15.0
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if not (300 < area < max_area):
                continue
            dist = cv2.pointPolygonTest(cnt, seed, measureDist=True)
            if dist >= 0:
                if area < best_area:
                    best_cnt, best_area = cnt, area
            elif -dist <= near_dist:
                near_cnt, near_dist = cnt, -dist
        if best_cnt is None:
            best_cnt = near_cnt

        roi_annotated = roi.copy()
        if best_cnt is not None:
            cv2.drawContours(roi_annotated, [best_cnt], -1, (0, 255, 255), 3)
            cv2.circle(roi_annotated, (int(seed[0]), int(seed[1])), 4, (0, 0, 255), -1)

        return best_cnt, roi_annotated

    def _visual_score(self, box_region_lab, tap, piece, ratios=BBOX_TO_BODY_RATIOS):
        """
        Procura o miolo da peça (nas 4 rotações e em várias escalas) dentro da região da caixa,
        aceitando só posições cujo centro fique a até meia peça do ponto tocado
        (senão uma vizinha do alvo, se estiver na mesa, "casaria" com a região).
        Retorna (melhor correlação normalizada, rotação horária em graus).
        """
        upright = piece.get("upright")
        if upright is None:
            return -1.0, 0

        ph, pw = upright.shape[:2]
        rh, rw = box_region_lab.shape[:2]
        best, best_rot = -1.0, 0
        for ratio in ratios:
            # Escala que leva o bbox da peça ao tamanho de (ratio × peça) na caixa normalizada
            scale = (BOX_PIECE_SIDE * ratio) / max(ph, pw)
            resized = cv2.resize(upright, (max(1, int(pw * scale)), max(1, int(ph * scale))),
                                 interpolation=cv2.INTER_AREA)
            th, tw = resized.shape[:2]
            ch, cw = int(th * CORE_FRACTION), int(tw * CORE_FRACTION)
            if ch < 8 or cw < 8:
                continue
            y0, x0 = (th - ch) // 2, (tw - cw) // 2
            core = cv2.cvtColor(resized[y0:y0 + ch, x0:x0 + cw], cv2.COLOR_BGR2LAB)
            # Miolo liso (céu, fundo) correlaciona com qualquer coisa: penaliza falta de textura
            texture = min(1.0, float(core[:, :, 0].std()) / MIN_TEXTURE_STD)

            for deg, code in ROTATIONS:
                tpl = _rotate(core, code)
                th2, tw2 = tpl.shape[:2]
                # Recorta só a área onde o centro do template fica a até `reach` do toque
                reach = BOX_PIECE_SIDE * 0.5
                xa = int(max(0, np.floor(tap[0] - tw2 / 2 - reach)))
                xb = int(min(rw, np.ceil(tap[0] + tw2 / 2 + reach) + 1))
                ya = int(max(0, np.floor(tap[1] - th2 / 2 - reach)))
                yb = int(min(rh, np.ceil(tap[1] + th2 / 2 + reach) + 1))
                if xb - xa < tw2 or yb - ya < th2:
                    continue
                res = cv2.matchTemplate(box_region_lab[ya:yb, xa:xb], tpl, cv2.TM_CCOEFF_NORMED)
                score = float(res.max()) * texture
                if score > best:
                    best, best_rot = score, deg
        return best, best_rot

    def match_target(self, box_patch, pieces, slot_contour=None):
        """
        Busca com duplo critério:
        1. Formato geométrico do encaixe (buraco no tabuleiro × contorno da peça)
        2. Textura e cores da arte da caixa (`box_patch` vindo de extract_box_patch)

        Retorna dict com a melhor peça, a rotação horária para encaixar, as similaridades e
        `confident`, que só é True quando a melhor peça se destaca claramente das demais.
        """
        box_lab = cv2.cvtColor(box_patch["image"], cv2.COLOR_BGR2LAB) if box_patch is not None else None

        scored = []
        for piece in pieces:
            shape_sim = None
            if slot_contour is not None and piece.get("contour") is not None:
                try:
                    # Invariante a escala e rotação via Hu Moments
                    d = cv2.matchShapes(piece["contour"], slot_contour, cv2.CONTOURS_MATCH_I1, 0.0)
                    shape_sim = 1.0 / (1.0 + 8.0 * d)
                except cv2.error:
                    shape_sim = 0.0

            visual, rotation = (None, 0)
            if box_lab is not None:
                visual, rotation = self._visual_score(box_lab, box_patch["tap"], piece, box_patch["ratios"])

            if shape_sim is not None and visual is not None:
                combined = 0.5 * shape_sim + 0.5 * max(0.0, visual)
            elif shape_sim is not None:
                combined = shape_sim
            else:
                combined = max(0.0, visual) if visual is not None else 0.0

            scored.append((combined, piece, rotation, shape_sim, visual))

        if not scored:
            return None

        scored.sort(key=lambda s: s[0], reverse=True)
        combined, piece, rotation, shape_sim, visual = scored[0]
        runner_up = scored[1] if len(scored) > 1 else None

        if visual is not None:
            other_visuals = [s[4] for s in scored[1:] if s[4] is not None]
            margin = visual - (max(other_visuals) if other_visuals else -1.0)
            confident = visual >= MIN_VISUAL_SCORE and margin >= MIN_VISUAL_MARGIN
        else:
            margin = shape_sim - (runner_up[3] if runner_up else 0.0)
            confident = shape_sim >= MIN_SHAPE_SIMILARITY and margin >= MIN_SHAPE_MARGIN

        return {
            "piece": piece,
            "rotation": rotation,
            "shape_similarity": shape_sim,
            "visual_score": visual,
            "score": combined,
            "confident": bool(confident),
        }

    def draw_highlight(self, table_bgr, piece, rotation, confident=True):
        annotated = table_bgr.copy()
        cx, cy = piece["centroid"]
        x, y, w, h = piece["bbox"]
        color = (0, 220, 0) if confident else (0, 200, 255)

        radius = int(max(w, h) * 0.95)
        cv2.circle(annotated, (cx, cy), radius, color, 6, cv2.LINE_AA)
        cv2.drawMarker(annotated, (cx, cy), color, cv2.MARKER_CROSS, 25, 3)

        # Sem acentos: a fonte Hershey do OpenCV não os desenha
        turn = {90: "girar 90 graus horario", 180: "girar 180 graus", 270: "girar 90 graus anti-horario"}
        label = f"PECA #{piece['id']}"
        if rotation in turn:
            label += f" | {turn[rotation]}"

        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.75, 2)
        ty = max(th + 12, cy - radius - 12)
        tx = min(max(0, x - 10), max(0, annotated.shape[1] - tw - 20))
        cv2.rectangle(annotated, (tx, ty - th - 12), (tx + tw + 16, ty + 8), (0, 0, 0), -1)
        cv2.putText(annotated, label, (tx + 8, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.75, color, 2, cv2.LINE_AA)
        return annotated
