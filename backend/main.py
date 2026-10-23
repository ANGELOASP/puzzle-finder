import base64, cv2, numpy as np
from typing import Optional
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
@app.get("/healthz")
def health():
    return {"status": "online", "message": "PuzzleFinder API online na nuvem!"}

@app.post("/api/find-piece")
async def find_piece(
    table_file: UploadFile = File(...),
    box_file: Optional[UploadFile] = File(None),
    board_file: Optional[UploadFile] = File(None),
    target_x_ratio: Optional[float] = Form(None),
    target_y_ratio: Optional[float] = Form(None),
    board_x_ratio: Optional[float] = Form(None),
    board_y_ratio: Optional[float] = Form(None)
):
    table_bgr = img_bytes_to_cv2(await table_file.read())
    
    # 1. Segmenta as peças soltas na mesa
    pieces = engine.segment_table_pieces(table_bgr)
    if not pieces:
        raise HTTPException(status_code=404, detail="Nenhuma peça encontrada na foto da mesa. Use um fundo com bom contraste.")

    target_patch = None
    slot_contour = None
    slot_roi_b64 = None

    # 2. Se o usuário enviou a foto do tabuleiro montado: extrai o formato do buraco
    if board_file is not None:
        board_bytes = await board_file.read()
        if len(board_bytes) > 0:
            board_bgr = img_bytes_to_cv2(board_bytes)
            hb, wb = board_bgr.shape[:2]
            
            bx_ratio = board_x_ratio if board_x_ratio is not None else 0.5
            by_ratio = board_y_ratio if board_y_ratio is not None else 0.5
            
            cx_board = int(bx_ratio * wb)
            cy_board = int(by_ratio * hb)
            
            slot_contour, roi_vis = engine.extract_slot_from_board(board_bgr, cx_board, cy_board)
            if roi_vis is not None:
                slot_roi_b64 = cv2_to_base64_jpeg(roi_vis)

    # 3. Se enviou a imagem da caixa: extrai o retalho de textura/cores correspondente
    if box_file is not None:
        box_bytes = await box_file.read()
        if len(box_bytes) > 0:
            box_bgr = img_bytes_to_cv2(box_bytes)
            h_box, w_box = box_bgr.shape[:2]
            
            tx_ratio = target_x_ratio if target_x_ratio is not None else (board_x_ratio if board_x_ratio is not None else 0.5)
            ty_ratio = target_y_ratio if target_y_ratio is not None else (board_y_ratio if board_y_ratio is not None else 0.5)
            
            cx = int(tx_ratio * w_box)
            cy = int(ty_ratio * h_box)
            patch_size = max(60, int(min(h_box, w_box) * 0.12))
            half = patch_size // 2

            target_patch = box_bgr[max(0, cy-half):min(h_box, cy+half), max(0, cx-half):min(w_box, cx+half)]

    if target_patch is None and slot_contour is None:
        raise HTTPException(status_code=400, detail="Por favor, envie a foto da Caixa ou a foto do Tabuleiro em montagem.")

    # 4. Encontra a melhor peça combinando Formato das Bordas + Textura da Arte
    best_piece, rotation, shape_sim = engine.match_target(target_patch, pieces, slot_contour=slot_contour)
    if not best_piece:
        raise HTTPException(status_code=404, detail="Não foi possível identificar com confiança a peça procurada.")

    annotated_table = engine.draw_highlight(table_bgr, best_piece, rotation, shape_sim=shape_sim)

    return {
        "piece_id": best_piece["id"],
        "rotation_deg": rotation,
        "shape_similarity": round(float(shape_sim) * 100, 1) if shape_sim else None,
        "centroid": best_piece["centroid"],
        "bbox": best_piece["bbox"],
        "piece_crop_base64": cv2_to_base64_jpeg(best_piece["crop"]),
        "annotated_table_base64": cv2_to_base64_jpeg(annotated_table),
        "slot_roi_base64": slot_roi_b64
    }
