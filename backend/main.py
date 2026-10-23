import base64, cv2, numpy as np
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from puzzle_engine import PuzzleEngine

app = FastAPI(title="PuzzleFinder API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
engine = PuzzleEngine()

def img_bytes_to_cv2(image_bytes: bytes):
    np_arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="Erro ao decodificar a imagem.")
    return img

def cv2_to_base64_jpeg(cv2_img):
    _, buffer = cv2.imencode('.jpg', cv2_img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return base64.b64encode(buffer).decode('utf-8')

@app.get("/")
def health():
    return {"status": "online"}

@app.post("/api/find-piece")
async def find_piece(
    box_file: UploadFile = File(...),
    table_file: UploadFile = File(...),
    target_x_ratio: float = Form(...),
    target_y_ratio: float = Form(...)
):
    box_bgr = img_bytes_to_cv2(await box_file.read())
    table_bgr = img_bytes_to_cv2(await table_file.read())

    h_box, w_box = box_bgr.shape[:2]
    cx = int(target_x_ratio * w_box)
    cy = int(target_y_ratio * h_box)
    patch_size = max(60, int(min(h_box, w_box) * 0.12))
    half = patch_size // 2

    target_patch = box_bgr[max(0, cy-half):min(h_box, cy+half), max(0, cx-half):min(w_box, cx+half)]
    pieces = engine.segment_table_pieces(table_bgr)
    if not pieces:
        raise HTTPException(status_code=404, detail="Nenhuma peça encontrada na foto da mesa.")

    best_piece, rotation = engine.match_target(target_patch, pieces)
    if not best_piece:
        raise HTTPException(status_code=404, detail="Nenhuma correspondência encontrada com confiança.")

    annotated_table = engine.draw_highlight(table_bgr, best_piece, rotation)

    return {
        "piece_id": best_piece["id"],
        "rotation_deg": rotation,
        "centroid": best_piece["centroid"],
        "bbox": best_piece["bbox"],
        "piece_crop_base64": cv2_to_base64_jpeg(best_piece["crop"]),
        "annotated_table_base64": cv2_to_base64_jpeg(annotated_table)
    }
