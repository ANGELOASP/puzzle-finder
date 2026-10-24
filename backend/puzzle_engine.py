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


def _rotate(img, code):
    return img if code is None else cv2.rotate(img, code)


class PuzzleEngine:

    def segment_table_pieces(self, table_img_bgr, max_area_fraction=0.25):
        """
        Separa as peças soltas do fundo da mesa, mesmo com centenas de peças e reflexos.
        - Fundo LOCAL (mediana numa janela de várias peças): absorve reflexos, sombras e mesa
          de vidro escura ou clara, e funciona com a mesa coberta de peças.
        - Watershed sobre a transformada de distância: separa peças encostadas ou ligadas por brilho.
        """
        h, w = table_img_bgr.shape[:2]
        lab = cv2.cvtColor(cv2.GaussianBlur(table_img_bgr, (3, 3), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
        s_ = 400.0 / max(h, w)
        small = cv2.resize(lab, None, fx=s_, fy=s_, interpolation=cv2.INTER_AREA)

        # 1ª passada com janela larga só para medir o tamanho típico das peças;
        # 2ª com janela de ~6 peças: acompanha reflexos sem "engolir" peças grandes
        fg = self._foreground(lab, small, int(round(max(small.shape[:2]) * 0.2)))
        n0, _, st0, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
        if n0 > 1:
            typical_area = float(np.median(st0[1:, cv2.CC_STAT_AREA]))
            diameter_small = np.sqrt(max(typical_area, 1.0)) * s_
            fg = self._foreground(lab, small, int(round(np.clip(6 * diameter_small, 15, max(small.shape[:2]) * 0.25))))

        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, kernel, iterations=1)
        fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, kernel, iterations=1)

        # Manchas bem maiores que uma peça típica são peças encostadas: só essas passam pelo
        # watershed (dividir as normais cortaria peças com "cintura" entre dois encaixes)
        n1, cc1, st1, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
        regions = fg.copy()
        # Raio do corpo pelos picos da transformada de distância: cada peça tem um, mesmo dentro de
        # uma "corrente" de peças encostadas — a área mediana não serve quando quase todas se tocam
        dt_all = cv2.distanceTransform(fg, cv2.DIST_L2, 5)
        peaks = dt_all[(dt_all == cv2.dilate(dt_all, np.ones((5, 5), np.uint8))) & (dt_all > 1.5)]
        # Pontas das abas também são picos (raio menor): o corpo é o grupo de cima
        radius = float(np.percentile(peaks, 75)) if peaks.size else 3.0
        single_area = 7.0 * radius * radius  # corpo ≈ 2,6 r de lado (com abas/encaixes)
        # Miolos fortes (bem dentro de um corpo): a "cintura" entre dois encaixes não chega a 0,75 r
        strong = (dt_all > 0.75 * radius).astype(np.uint8)
        n_s, s_lab = cv2.connectedComponents(strong)
        big_ids = []
        for i in range(1, n1):
            if st1[i, cv2.CC_STAT_AREA] > 1.5 * single_area:
                x0, y0, ww, hh = st1[i, :4]
                inside = s_lab[y0:y0 + hh, x0:x0 + ww][cc1[y0:y0 + hh, x0:x0 + ww] == i]
                if len(np.unique(inside[inside > 0])) >= 2:  # 2+ miolos = 2+ peças encostadas
                    big_ids.append(i)
        if big_ids:
            big = np.isin(cc1, big_ids)
            fg_big = (big & (fg > 0)).astype(np.uint8) * 255
            seeds = (strong.astype(bool) & big).astype(np.uint8)
            _, markers = cv2.connectedComponents(seeds)
            markers = markers + 1
            markers[(fg_big > 0) & (seeds == 0)] = 0
            ws = cv2.watershed(cv2.cvtColor(fg_big, cv2.COLOR_GRAY2BGR), markers.astype(np.int32))
            regions[big & (ws == -1)] = 0  # linhas de corte entre as peças grudadas

        # Cada região vira uma peça
        n, cc, stats, centroids = cv2.connectedComponentsWithStats((regions > 0).astype(np.uint8), connectivity=4)
        areas = stats[1:, cv2.CC_STAT_AREA]
        if not len(areas):
            return []
        min_area = max(30.0, single_area * 0.25)
        max_area = min(h * w * max_area_fraction, single_area * 8)

        pieces = []
        for i in range(1, n):
            x, y, bw, bh, area = stats[i]
            if not (min_area < area < max_area):
                continue
            mask = (cc[y:y + bh, x:x + bw] == i).astype(np.uint8) * 255
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

    def _foreground(self, lab, small, k):
        """Máscara peça × fundo, com o fundo estimado pela mediana numa janela de k px (na escala `small`)."""
        h, w = lab.shape[:2]
        k = max(3, int(k) | 1)
        bg = np.dstack([cv2.medianBlur(np.clip(small[..., c], 0, 255).astype(np.uint8), k) for c in range(3)])
        bg = cv2.resize(bg.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
        # Cor pesa mais que luz: reflexos mudam a luminância, peças mudam a cor
        dist = np.linalg.norm((lab - bg) * np.array([1.0, 1.4, 1.4], np.float32), axis=2)
        dist8 = np.clip(dist * 3, 0, 255).astype(np.uint8)
        otsu, _ = cv2.threshold(dist8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        # Otsu fica alto quando as peças contrastam muito e corta abas de cor parecida com a mesa:
        # o ruído do próprio fundo (pixels claramente de fundo) serve de teto para o limiar
        background = dist8[dist8 < otsu * 0.5]
        noise = float(np.percentile(background, 99)) * 2.0 + 4.0 if background.size else otsu
        _, fg = cv2.threshold(dist8, max(6.0, min(otsu, noise)), 255, cv2.THRESH_BINARY)
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
