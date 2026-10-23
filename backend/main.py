import base64, hashlib, json, os, threading, time, urllib.error, urllib.request
import cv2, numpy as np
from typing import Optional
from fastapi import Depends, FastAPI, UploadFile, File, Form, Header, HTTPException
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

# Login: a API só atende quem tem sessão válida no Supabase Auth (mesmo projeto do frontend).
# URL e anon key são públicas; REQUIRE_AUTH=false desliga a checagem (desenvolvimento local).
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://gfjxcsvxhaojbtuixpjh.supabase.co").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmanhjc3Z4aGFvamJ0dWl4cGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyMzU5NjYsImV4cCI6MjEwNjgxMTk2Nn0.gKx3hutXIkemUfVR_O7MFnibpUxY_tYslNSY1D1M4ds",
)
REQUIRE_AUTH = os.environ.get("REQUIRE_AUTH", "true").lower() != "false"
# O scanner manda vários quadros por segundo: guarda tokens já validados por alguns minutos
TOKEN_CACHE_SECONDS = 300
_token_cache = {}
_token_cache_lock = threading.Lock()

def fetch_supabase_user(token: str) -> Optional[dict]:
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={"Authorization": f"Bearer {token}", "apikey": SUPABASE_ANON_KEY},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return None
        raise HTTPException(status_code=503, detail="Não foi possível validar o login agora. Tente de novo.")
    except (urllib.error.URLError, TimeoutError):
        raise HTTPException(status_code=503, detail="Não foi possível validar o login agora. Tente de novo.")

def require_user(authorization: Optional[str] = Header(None)) -> Optional[str]:
    """Dependência: devolve o id do usuário logado (ou None com REQUIRE_AUTH=false)."""
    if not REQUIRE_AUTH:
        return None
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Faça login para usar o PuzzleFinder.")
    token = authorization[7:].strip()
    key = hashlib.sha256(token.encode()).hexdigest()
    now = time.time()
    with _token_cache_lock:
        cached = _token_cache.get(key)
        if cached and cached[1] > now:
            return cached[0]

    user = fetch_supabase_user(token)
    if not user or not user.get("id"):
        raise HTTPException(status_code=401, detail="Sessão expirada. Entre de novo.")

    with _token_cache_lock:
        if len(_token_cache) > 1000:
            _token_cache.clear()
        _token_cache[key] = (user["id"], now + TOKEN_CACHE_SECONDS)
    return user["id"]

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
    user_id: Optional[str] = Depends(require_user),
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
