import base64, cv2, numpy as np
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from puzzle_engine import PuzzleEngine

# O frontend já comprime as fotos para ~1600 px (≈300 KB); 8 MB cobre fotos originais com folga
MAX_UPLOAD_BYTES = 8 * 1024 * 1024

app = FastAPI(title="PuzzleFinder API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
engine = PuzzleEngine()

async def read_upload(upload: Optional[UploadFile]) -> Optional[bytes]:
    if upload is None:
        return None
    data = await upload.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Imagem muito grande (máx. 8 MB).")
    return data or None

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
    board_y_ratio: Optional[float] = Form(None),
    total_pieces: Optional[int] = Form(None),
    annotate: bool = Form(True),
):
    table_bytes = await read_upload(table_file)
    if table_bytes is None:
        raise HTTPException(status_code=400, detail="Foto da mesa vazia.")
    board_bytes = await read_upload(board_file)
    box_bytes = await read_upload(box_file)

    # OpenCV é CPU-bound: roda fora do event loop para não travar outras requisições
    return await run_in_threadpool(
        process_find_piece, table_bytes, box_bytes, board_bytes,
        target_x_ratio, target_y_ratio, board_x_ratio, board_y_ratio, total_pieces, annotate,
    )

def process_find_piece(table_bytes, box_bytes, board_bytes,
                       target_x_ratio, target_y_ratio, board_x_ratio, board_y_ratio,
                       total_pieces, annotate):
    table_bgr = img_bytes_to_cv2(table_bytes)

    # 1. Segmenta as peças soltas na mesa
    pieces = engine.segment_table_pieces(table_bgr)
    if not pieces:
        raise HTTPException(status_code=404, detail="Nenhuma peça encontrada na foto da mesa. Espalhe as peças sobre um fundo liso.")

    box_patch = None
    slot_contour = None
    slot_roi_b64 = None

    # 2. Se o usuário enviou a foto do tabuleiro montado: extrai o formato do buraco
    if board_bytes is not None and board_x_ratio is not None and board_y_ratio is not None:
        board_bgr = img_bytes_to_cv2(board_bytes)
        hb, wb = board_bgr.shape[:2]
        slot_contour, roi_vis = engine.extract_slot_from_board(
            board_bgr, int(board_x_ratio * wb), int(board_y_ratio * hb))
        if roi_vis is not None and annotate:
            slot_roi_b64 = cv2_to_base64_jpeg(roi_vis)

    # 3. Se enviou a imagem da caixa com o ponto marcado: recorta a região correspondente da arte
    if box_bytes is not None and target_x_ratio is not None and target_y_ratio is not None:
        box_bgr = img_bytes_to_cv2(box_bytes)
        box_patch = engine.extract_box_patch(box_bgr, target_x_ratio, target_y_ratio, total_pieces)

    if box_patch is None and slot_contour is None:
        raise HTTPException(status_code=400, detail="Marque o buraco no tabuleiro ou o ponto na imagem da caixa.")

    # 4. Encontra a melhor peça combinando Formato das Bordas + Textura da Arte
    match = engine.match_target(box_patch, pieces, slot_contour=slot_contour)
    if not match:
        raise HTTPException(status_code=404, detail="Não foi possível identificar a peça procurada.")

    best_piece = match["piece"]
    shape_sim = match["shape_similarity"]
    result = {
        "piece_id": best_piece["id"],
        "pieces_detected": len(pieces),
        "rotation_deg": match["rotation"],
        "confident": match["confident"],
        "score": round(match["score"] * 100, 1),
        "shape_similarity": round(shape_sim * 100, 1) if shape_sim else None,
        "centroid": best_piece["centroid"],
        "bbox": best_piece["bbox"],
        "frame_size": [table_bgr.shape[1], table_bgr.shape[0]],
    }
    # O scanner em tempo real só precisa das coordenadas: pular as imagens economiza banda a cada quadro
    if annotate:
        annotated_table = engine.draw_highlight(
            table_bgr, best_piece, match["rotation"], confident=match["confident"])
        result["piece_crop_base64"] = cv2_to_base64_jpeg(best_piece["crop"])
        result["annotated_table_base64"] = cv2_to_base64_jpeg(annotated_table)
        result["slot_roi_base64"] = slot_roi_b64
    return result
