import base64, hashlib, json, os, threading, time, urllib.error, urllib.request
import cv2, numpy as np
from typing import List, Optional
from fastapi import Depends, FastAPI, UploadFile, File, Form, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
import grid_engine
from paper import TablePhoto, balance_pieces_on_background
from puzzle_engine import PuzzleEngine

# A foto da mesa vai em alta resolução (centenas de peças pequenas): até ~3000 px ≈ 2-5 MB
MAX_UPLOAD_BYTES = 12 * 1024 * 1024
# Lado máximo processado da foto da mesa: mais que isso estoura a memória do plano gratuito
MAX_TABLE_SIDE = 3000
# Fotos de peças por busca (ex.: uma folha A4 cheia por foto)
MAX_TABLE_PHOTOS = 8
# Lado (px) da miniatura de cada peça na busca inversa
LOCATE_THUMB = 120

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
        raise HTTPException(status_code=413, detail="Imagem muito grande (máx. 12 MB).")
    return data or None

def img_bytes_to_cv2(image_bytes: bytes, max_side: Optional[int] = None):
    np_arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="Erro ao decodificar a imagem.")
    if max_side and max(img.shape[:2]) > max_side:
        f = max_side / float(max(img.shape[:2]))
        img = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    return img

def parse_points(raw: Optional[str]):
    """'[[x,y],...]' normalizado 0..1 → lista de tuplas (ignora valores inválidos)."""
    if not raw:
        return None
    try:
        pts = [(float(p[0]), float(p[1])) for p in json.loads(raw)]
    except (ValueError, TypeError, IndexError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="Pontos inválidos.")
    return [p for p in pts if 0 <= p[0] <= 1 and 0 <= p[1] <= 1] or None

def check_grid(cols: int, rows: int):
    if not (2 <= cols <= 200 and 2 <= rows <= 200):
        raise HTTPException(status_code=400, detail="Grade inválida: colunas e linhas entre 2 e 200.")

def cv2_to_base64_jpeg(cv2_img, quality=85):
    _, buffer = cv2.imencode('.jpg', cv2_img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(buffer).decode('utf-8')

@app.get("/")
@app.get("/healthz")
def health():
    return {"status": "online", "message": "PuzzleFinder API online na nuvem!"}

async def read_tables(table_file, table_files):
    """Fotos das peças: `table_file` (uma) e/ou `table_files` (várias)."""
    uploads = ([table_file] if table_file is not None else []) + list(table_files or [])
    if len(uploads) > MAX_TABLE_PHOTOS:
        raise HTTPException(status_code=400, detail=f"Envie no máximo {MAX_TABLE_PHOTOS} fotos de peças por busca.")
    tables = [b for b in [await read_upload(u) for u in uploads] if b]
    if not tables:
        raise HTTPException(status_code=400, detail="Envie ao menos uma foto das peças.")
    return tables


def segment_tables(tables, piece_mm=None):
    """
    Cada foto: acha a folha A4 (endireita, balanço de branco, escala) e separa as peças.
    Cada peça ganha "photo" (índice da foto) e, com folha e tamanho da peça conhecidos, "body_px".
    """
    photos, pieces = [], []
    for i, data in enumerate(tables):
        photo = TablePhoto(img_bytes_to_cv2(data, MAX_TABLE_SIDE))
        found = engine.segment_table_pieces(photo.image)
        # Branco de referência: a folha A4 inteira (já corrigida na foto endireitada) ou o papel/mesa
        # clara em volta das peças quando a folha ocupa a foto toda (o padrão)
        photo.white_ref = photo.on_paper or balance_pieces_on_background(photo.image, found) is not None
        for p in found:
            p["photo"] = i
            if photo.px_per_mm and piece_mm:
                p["body_px"] = piece_mm * photo.px_per_mm
        photo.pieces = len(found)
        photos.append(photo)
        pieces += found
    if not pieces:
        raise HTTPException(status_code=404, detail="Nenhuma peça encontrada nas fotos. Espalhe as peças sobre uma folha A4 branca, sem encostar umas nas outras.")
    return photos, pieces


def piece_location(photos, piece):
    """bbox e centro da peça na foto ORIGINAL (o scanner ao vivo desenha sobre o vídeo)."""
    photo = photos[piece["photo"]]
    (cx, cy), = photo.to_original([piece["centroid"]])
    return photo.bbox_to_original(piece["bbox"]), [int(round(cx)), int(round(cy))]


def piece_thumb(piece):
    """Miniatura JPEG (base64) da peça endireitada, com o fundo da foto em volta."""
    img = piece["upright"] if piece.get("upright") is not None else piece["crop"]
    s = LOCATE_THUMB / float(max(img.shape[:2]))
    img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    return cv2_to_base64_jpeg(img, quality=80)


def photos_summary(photos):
    return [{"frame_size": list(p.original_size), "on_paper": p.on_paper, "white_ref": p.white_ref,
             "pieces": p.pieces} for p in photos]


def fit_jpeg(img, max_side=2000):
    if max(img.shape[:2]) > max_side:
        f = max_side / float(max(img.shape[:2]))
        img = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    return cv2_to_base64_jpeg(img)


@app.post("/api/find-piece")
async def find_piece(
    table_file: Optional[UploadFile] = File(None),
    table_files: Optional[List[UploadFile]] = File(None),
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
    tables = await read_tables(table_file, table_files)
    board_bytes = await read_upload(board_file)
    box_bytes = await read_upload(box_file)

    # OpenCV é CPU-bound: roda fora do event loop para não travar outras requisições
    return await run_in_threadpool(
        process_find_piece, tables, box_bytes, board_bytes,
        target_x_ratio, target_y_ratio, board_x_ratio, board_y_ratio, total_pieces, annotate,
    )

def process_find_piece(tables, box_bytes, board_bytes,
                       target_x_ratio, target_y_ratio, board_x_ratio, board_y_ratio,
                       total_pieces, annotate):
    # 1. Separa as peças soltas de todas as fotos
    photos, pieces = segment_tables(tables)

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
    bbox, centroid = piece_location(photos, best_piece)
    result = {
        "piece_id": best_piece["id"],
        "pieces_detected": len(pieces),
        "rotation_deg": match["rotation"],
        "confident": match["confident"],
        "score": round(match["score"] * 100, 1),
        "shape_similarity": round(shape_sim * 100, 1) if shape_sim else None,
        "photo": best_piece["photo"],
        "centroid": centroid,
        "bbox": bbox,
        "frame_size": list(photos[best_piece["photo"]].original_size),
        "photos": photos_summary(photos),
    }
    # O scanner em tempo real só precisa das coordenadas: pular as imagens economiza banda a cada quadro
    if annotate:
        annotated_table = engine.draw_highlight(
            photos[best_piece["photo"]].image, best_piece, match["rotation"], confident=match["confident"])
        result["piece_crop_base64"] = cv2_to_base64_jpeg(best_piece["crop"])
        result["annotated_table_base64"] = fit_jpeg(annotated_table)
        result["slot_roi_base64"] = slot_roi_b64
    return result


@app.post("/api/scan-board")
async def scan_board(
    box_file: UploadFile = File(...),
    board_file: UploadFile = File(...),
    cols: int = Form(...),
    rows: int = Form(...),
    margin: float = Form(0.0),
    mat_points: Optional[str] = Form(None),
    user_id: Optional[str] = Depends(require_user),
):
    """
    Mapa do tabuleiro: recebe a arte e o tabuleiro já retificados pelo app (cols × rows células;
    o tabuleiro com `margin` células de mesa em volta) e diz quais células estão montadas.
    """
    check_grid(cols, rows)
    box_bytes, board_bytes = await read_upload(box_file), await read_upload(board_file)
    if box_bytes is None or board_bytes is None:
        raise HTTPException(status_code=400, detail="Envie a arte e a foto do tabuleiro.")
    points = parse_points(mat_points)
    return await run_in_threadpool(process_scan, box_bytes, board_bytes, cols, rows, max(0.0, min(3.0, margin)), points)

def process_scan(box_bytes, board_bytes, cols, rows, margin, points):
    box = img_bytes_to_cv2(box_bytes)
    board = img_bytes_to_cv2(board_bytes)
    res = grid_engine.scan_board(box, board, cols, rows, margin, mat_points=points)
    placed = res["placed"]
    overlay = grid_engine.draw_scan(board, cols, rows, margin, placed)
    if max(overlay.shape[:2]) > 1600:
        f = 1600.0 / max(overlay.shape[:2])
        overlay = cv2.resize(overlay, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    n_placed = int(placed.sum())
    return {
        "cols": cols,
        "rows": rows,
        # Linha por linha, de cima para baixo: '1' montada, '0' vazia
        "placed_map": "".join("1" if v else "0" for v in placed.reshape(-1)),
        "placed": n_placed,
        "missing": cols * rows - n_placed,
        "total": cols * rows,
        "mat_found": res["mat_found"],
        "confidence": round(float(res["confidence"].mean()), 3),
        "overlay_base64": cv2_to_base64_jpeg(overlay),
    }


@app.post("/api/locate-pieces")
async def locate_pieces(
    table_files: Optional[List[UploadFile]] = File(None),
    table_file: Optional[UploadFile] = File(None),
    box_file: UploadFile = File(...),
    cols: int = Form(...),
    rows: int = Form(...),
    scan_map: Optional[str] = Form(None),
    piece_mm: Optional[float] = Form(None),
    top_k: int = Form(5),
    user_id: Optional[str] = Depends(require_user),
):
    """
    Busca inversa: para CADA peça solta das fotos, as células (entre as que faltam no `scan_map`)
    onde ela mais provavelmente vai, com a rotação. É o caminho "fotografei estas peças: onde vão?".
    """
    check_grid(cols, rows)
    tables = await read_tables(table_file, table_files)
    box_bytes = await read_upload(box_file)
    if box_bytes is None:
        raise HTTPException(status_code=400, detail="Envie a arte.")
    if piece_mm is not None and not (3.0 <= piece_mm <= 100.0):
        piece_mm = None
    return await run_in_threadpool(process_locate_pieces, tables, box_bytes, cols, rows, scan_map, piece_mm,
                                   max(1, min(10, top_k)))

def process_locate_pieces(tables, box_bytes, cols, rows, scan_map, piece_mm, top_k):
    box = img_bytes_to_cv2(box_bytes)
    photos, pieces = segment_tables(tables, piece_mm)
    color_tf = grid_engine.color_normalizer(pieces, box, cols, rows, scan_map)
    located = grid_engine.locate_pieces(box, cols, rows, pieces, scan_map, color_tf, top_k=top_k)
    out = []
    for i, (p, cands) in enumerate(zip(pieces, located)):
        if not cands:
            continue
        bbox, centroid = piece_location(photos, p)
        shapes = grid_engine.side_shapes(p.get("upright_mask"))
        out.append({
            "id": i,
            "photo": p["photo"],
            "bbox": bbox,
            "centroid": centroid,
            # Peça endireitada (é ela que a rotação dos candidatos gira)
            "thumb_base64": piece_thumb(p),
            "sides": shapes,
            "candidates": [{
                "col": c["col"], "row": c["row"], "rotation_deg": c["rotation"],
                "score": round(c["score"] * 100, 1),
            } for c in cands],
            "confident": cands[0]["score"] >= grid_engine.LOCATE_CONFIDENT,
        })
    return {
        "pieces": out,
        "pieces_detected": len(pieces),
        "photos": photos_summary(photos),
        "missing_cells": scan_map.count("0") if scan_map and len(scan_map) == cols * rows else cols * rows,
    }


@app.post("/api/find-cell")
async def find_cell(
    table_file: Optional[UploadFile] = File(None),
    table_files: Optional[List[UploadFile]] = File(None),
    box_file: UploadFile = File(...),
    cols: int = Form(...),
    rows: int = Form(...),
    col: int = Form(...),
    row: int = Form(...),
    top_k: int = Form(5),
    annotate: bool = Form(True),
    hole_file: Optional[UploadFile] = File(None),
    scan_map: Optional[str] = Form(None),
    piece_mm: Optional[float] = Form(None),
    user_id: Optional[str] = Depends(require_user),
):
    """
    Busca a peça da célula (col, row) da arte retificada entre as peças soltas das fotos.
    - `table_file`/`table_files`: uma ou várias fotos das peças (de preferência sobre folha A4).
    - `hole_file` (opcional): o tabuleiro endireitado em volta da célula vazia (3 × 3 células, ela no
      meio) — o formato do buraco filtra as peças pelas abas e encaixes.
    - `scan_map` (opcional): mapa do último escaneamento ('1' montada, '0' faltando) — as cores da
      arte das células que faltam viram a referência para normalizar as cores das fotos.
    - `piece_mm` (opcional): largura de uma peça em mm (largura do quebra-cabeça / colunas); com a
      folha A4 na foto, dá o tamanho exato de cada peça em px.
    """
    check_grid(cols, rows)
    if not (0 <= col < cols and 0 <= row < rows):
        raise HTTPException(status_code=400, detail="Peça fora da grade.")
    tables = await read_tables(table_file, table_files)
    box_bytes = await read_upload(box_file)
    if box_bytes is None:
        raise HTTPException(status_code=400, detail="Envie a arte.")
    hole_bytes = await read_upload(hole_file)
    if piece_mm is not None and not (3.0 <= piece_mm <= 100.0):
        piece_mm = None
    return await run_in_threadpool(process_find_cell, tables, box_bytes, cols, rows, col, row,
                                   max(1, min(10, top_k)), annotate, hole_bytes, scan_map, piece_mm)

def process_find_cell(tables, box_bytes, cols, rows, col, row, top_k, annotate,
                      hole_bytes=None, scan_map=None, piece_mm=None):
    box = img_bytes_to_cv2(box_bytes)
    photos, pieces = segment_tables(tables, piece_mm)
    hole = None
    if hole_bytes:
        hole = grid_engine.hole_shapes(img_bytes_to_cv2(hole_bytes), 3, 3, 0, 1, 1,
                                       flats=grid_engine.expected_flats(cols, rows, col, row))
    color_tf = grid_engine.color_normalizer(pieces, box, cols, rows, scan_map)
    patch = grid_engine.cell_patch(box, cols, rows, col, row)
    ranked = grid_engine.match_cell(patch, pieces, top_k=top_k, hole=hole, color_tf=color_tf)
    if not ranked:
        raise HTTPException(status_code=404, detail="Não foi possível comparar as peças das fotos.")
    confident = grid_engine.is_confident(ranked)
    candidates = []
    for i, c in enumerate(ranked):
        bbox, centroid = piece_location(photos, c["piece"])
        candidates.append({
            "rank": i + 1,
            "photo": c["piece"]["photo"],
            "bbox": bbox,
            "centroid": centroid,
            "rotation_deg": c["rotation"],
            "score": round(c["score"] * 100, 1),
            "edge_ok": c["flats_ok"],
            "shape_ok": c["shape_ok"],
            # Peça endireitada: a tela de comparação gira esta imagem por rotation_deg
            "thumb_base64": piece_thumb(c["piece"]),
        })
    best_photo = ranked[0]["piece"]["photo"]
    result = {
        "pieces_detected": len(pieces),
        "confident": confident,
        # Tamanho da foto da melhor candidata (o scanner ao vivo usa para desenhar sobre o vídeo)
        "frame_size": list(photos[best_photo].original_size),
        "photos": photos_summary(photos),
        "candidates": candidates,
        # Formato do buraco usado no filtro (lado → "tab"/"blank"/"flat"/None), ou None
        "hole": hole,
    }
    if annotate:
        # Uma imagem por foto que tem candidatas (folha endireitada, quando há folha), numeradas
        # pela posição na lista geral
        images = []
        for i, photo in enumerate(photos):
            mine = [(k, c) for k, c in enumerate(ranked) if c["piece"]["photo"] == i]
            if mine:
                ranks, cands = zip(*mine)
                img = grid_engine.draw_candidates(photo.image, list(cands), confident, ranks=list(ranks))
                images.append({"photo": i, "image_base64": fit_jpeg(img)})
        result["annotated_tables"] = images
        result["annotated_table_base64"] = next(im["image_base64"] for im in images if im["photo"] == best_photo)
        x, y, w, h = ranked[0]["piece"]["bbox"]
        result["piece_crop_base64"] = cv2_to_base64_jpeg(photos[best_photo].image[y:y + h, x:x + w])
    return result

