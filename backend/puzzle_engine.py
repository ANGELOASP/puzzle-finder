import cv2
import numpy as np

class PuzzleEngine:
    def __init__(self):
        self.orb = cv2.ORB_create(nfeatures=2000)
        self.matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)

    def segment_table_pieces(self, table_img_bgr, min_area=350, max_area=80000):
        gray = cv2.cvtColor(table_img_bgr, cv2.COLOR_BGR2GRAY)
        blurred = cv2.bilateralFilter(gray, 9, 75, 75)
        _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        morph = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)
        contours, _ = cv2.findContours(morph, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        pieces = []
        piece_id = 1
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if min_area < area < max_area:
                x, y, w, h = cv2.boundingRect(cnt)
                mask = np.zeros(gray.shape, dtype=np.uint8)
                cv2.drawContours(mask, [cnt], -1, 255, -1)
                
                crop = table_img_bgr[y:y+h, x:x+w]
                crop_mask = mask[y:y+h, x:x+w]
                
                M = cv2.moments(cnt)
                cx = int(M["m10"] / M["m00"]) if M["m00"] != 0 else x + w // 2
                cy = int(M["m01"] / M["m00"]) if M["m00"] != 0 else y + h // 2
                
                kp, des = self.orb.detectAndCompute(crop, mask=crop_mask)
                
                # Guarda contorno normalizado e original da peça
                pieces.append({
                    "id": piece_id,
                    "bbox": (x, y, w, h),
                    "centroid": (cx, cy),
                    "crop": crop,
                    "mask": crop_mask,
                    "contour": cnt,
                    "area": area,
                    "descriptors": des
                })
                piece_id += 1
        return pieces

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
        
        seed_x = cx - x1
        seed_y = cy - y1
        best_cnt = None
        min_dist = float('inf')

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if 300 < area < (roi.shape[0] * roi.shape[1] * 0.85):
                dist = cv2.pointPolygonTest(cnt, (float(seed_x), float(seed_y)), measureDist=True)
                if dist >= -15:
                    if abs(dist) < min_dist or dist > 0:
                        min_dist = abs(dist)
                        best_cnt = cnt

        roi_annotated = roi.copy()
        if best_cnt is not None:
            cv2.drawContours(roi_annotated, [best_cnt], -1, (0, 255, 255), 3)
            cv2.circle(roi_annotated, (seed_x, seed_y), 4, (0, 0, 255), -1)

        return best_cnt, roi_annotated

    def match_target(self, target_patch_bgr, pieces, slot_contour=None):
        """
        Busca inteligente com duplo critério:
        1. Formato geométrico do encaixe (interlocking tabs & blanks)
        2. Textura, cores e padrão visual da caixa
        """
        best_score = -1
        best_piece = None
        best_rotation = 0
        best_shape_sim = 0.0

        target_gray = cv2.cvtColor(target_patch_bgr, cv2.COLOR_BGR2GRAY) if target_patch_bgr is not None else None

        for piece in pieces:
            # 1. Pontuação Geométrica (Formato do Encaixe)
            shape_score = 0.0
            shape_similarity = 0.0
            if slot_contour is not None and piece.get("contour") is not None:
                try:
                    # Invariante a escala e rotação via Hu Moments
                    shape_dist = cv2.matchShapes(piece["contour"], slot_contour, cv2.CONTOURS_MATCH_I1, 0.0)
                    # Converte distância em pontuação de 0 a 100%
                    shape_similarity = max(0.0, 1.0 - (shape_dist * 1.5))
                    shape_score = (100.0 / (1.0 + 8.0 * shape_dist))
                except cv2.error:
                    shape_score = 0.0

            # 2. Pontuação Visual (Textura e Cores)
            visual_score = 0.0
            piece_rotation = 0

            if target_gray is not None and piece["descriptors"] is not None and len(piece["descriptors"]) >= 5:
                best_rot_score = -1
                for angle in [0, 90, 180, 270]:
                    if angle == 0: rot_gray = target_gray
                    elif angle == 90: rot_gray = cv2.rotate(target_gray, cv2.ROTATE_90_CLOCKWISE)
                    elif angle == 180: rot_gray = cv2.rotate(target_gray, cv2.ROTATE_180)
                    else: rot_gray = cv2.rotate(target_gray, cv2.ROTATE_90_COUNTERCLOCKWISE)

                    kp_t, des_t = self.orb.detectAndCompute(rot_gray, None)
                    if des_t is None or len(des_t) < 5: continue

                    try:
                        matches = self.matcher.match(des_t, piece["descriptors"])
                        good = [m for m in matches if m.distance < 45]
                        score = len(good)
                        if score > best_rot_score:
                            best_rot_score = score
                            piece_rotation = angle
                    except cv2.error:
                        continue
                visual_score = max(0, best_rot_score)

            # Combinação ponderada de formato + textura
            if slot_contour is not None and target_gray is not None:
                # Dupla checagem: formato (peso 60%) + textura (peso 40%)
                combined_score = (shape_score * 2.5) + (visual_score * 1.8)
            elif slot_contour is not None:
                combined_score = shape_score * 3.0
            else:
                combined_score = visual_score * 2.0

            if combined_score > best_score:
                best_score = combined_score
                best_piece = piece
                best_rotation = piece_rotation
                best_shape_sim = shape_similarity

        return best_piece, best_rotation, best_shape_sim

    def draw_highlight(self, table_bgr, piece, rotation, shape_sim=None):
        annotated = table_bgr.copy()
        cx, cy = piece["centroid"]
        x, y, w, h = piece["bbox"]
        
        radius = int(max(w, h) * 0.95)
        # Círculo verde neon
        cv2.circle(annotated, (cx, cy), radius, (0, 255, 0), 6, cv2.LINE_AA)
        cv2.drawMarker(annotated, (cx, cy), (0, 255, 0), cv2.MARKER_CROSS, 25, 3)

        label = f"PECA #{piece['id']} (Girar {rotation} deg)"
        if shape_sim is not None and shape_sim > 0:
            label += f" | Forma: {int(shape_sim * 100)}%"

        cv2.rectangle(annotated, (x - 10, y - 50), (x + 380, y - 5), (0, 0, 0), -1)
        cv2.putText(annotated, label, (x - 5, y - 18), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0, 255, 0), 2, cv2.LINE_AA)
        return annotated
