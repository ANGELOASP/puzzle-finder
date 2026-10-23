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

    def segment_table_pieces(self, table_img_bgr, min_area=350, max_area_fraction=0.25):
        """
        Separa as peças soltas do fundo da mesa.
        A cor do fundo é estimada pela borda da foto, então funciona em mesa clara, escura ou colorida.
        """
        h, w = table_img_bgr.shape[:2]
        lab = cv2.cvtColor(cv2.GaussianBlur(table_img_bgr, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)

        border = max(4, int(min(h, w) * 0.02))
        edge_pixels = np.concatenate([
            lab[:border].reshape(-1, 3), lab[-border:].reshape(-1, 3),
            lab[:, :border].reshape(-1, 3), lab[:, -border:].reshape(-1, 3),
        ])
        background = np.median(edge_pixels, axis=0)

        dist = np.linalg.norm(lab - background, axis=2)
        dist = cv2.normalize(dist, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        _, fg = cv2.threshold(dist, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, kernel, iterations=1)
        fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, kernel, iterations=2)
        contours, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        max_area = h * w * max_area_fraction
        pieces = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if not (min_area < area < max_area):
                continue

            x, y, bw, bh = cv2.boundingRect(cnt)
            mask = np.zeros((h, w), dtype=np.uint8)
            cv2.drawContours(mask, [cnt], -1, 255, -1)

            M = cv2.moments(cnt)
            cx = int(M["m10"] / M["m00"]) if M["m00"] != 0 else x + bw // 2
            cy = int(M["m01"] / M["m00"]) if M["m00"] != 0 else y + bh // 2

            pieces.append({
                "id": len(pieces) + 1,
                "bbox": (x, y, bw, bh),
                "centroid": (cx, cy),
                "crop": table_img_bgr[y:y + bh, x:x + bw],
                "mask": mask[y:y + bh, x:x + bw],
                "contour": cnt,
                "area": area,
                "upright": self._deskew(table_img_bgr, cnt),
            })
        return pieces

    def _deskew(self, img_bgr, contour):
        """Recorta a peça alinhada aos eixos (remove a inclinação de até 45°)."""
        (rcx, rcy), (rw, rh), angle = cv2.minAreaRect(contour)
        if rw < 2 or rh < 2:
            return None
        if angle > 45:
            angle -= 90
            rw, rh = rh, rw
        elif angle < -45:
            angle += 90
            rw, rh = rh, rw
        M = cv2.getRotationMatrix2D((rcx, rcy), angle, 1.0)
        M[0, 2] += rw / 2 - rcx
        M[1, 2] += rh / 2 - rcy
        return cv2.warpAffine(img_bgr, M, (int(round(rw)), int(round(rh))), flags=cv2.INTER_LINEAR)

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
