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
                pieces.append({
                    "id": piece_id, "bbox": (x, y, w, h),
                    "centroid": (cx, cy), "crop": crop, "descriptors": des
                })
                piece_id += 1
        return pieces

    def match_target(self, target_patch_bgr, pieces):
        best_score, best_piece, best_rotation = -1, None, 0
        target_gray = cv2.cvtColor(target_patch_bgr, cv2.COLOR_BGR2GRAY)

        for piece in pieces:
            if piece["descriptors"] is None or len(piece["descriptors"]) < 5:
                continue
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
                    if len(good) > best_score:
                        best_score, best_piece, best_rotation = len(good), piece, angle
                except cv2.error:
                    continue
        return best_piece, best_rotation

    def draw_highlight(self, table_bgr, piece, rotation):
        annotated = table_bgr.copy()
        cx, cy = piece["centroid"]
        x, y, w, h = piece["bbox"]
        radius = int(max(w, h) * 0.9)
        cv2.circle(annotated, (cx, cy), radius, (0, 255, 0), 6, cv2.LINE_AA)
        cv2.drawMarker(annotated, (cx, cy), (0, 255, 0), cv2.MARKER_CROSS, 25, 3)
        label = f"PECA #{piece['id']} (Girar {rotation} deg)"
        cv2.rectangle(annotated, (x - 10, y - 50), (x + 320, y - 5), (0, 0, 0), -1)
        cv2.putText(annotated, label, (x - 5, y - 18), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2, cv2.LINE_AA)
        return annotated
