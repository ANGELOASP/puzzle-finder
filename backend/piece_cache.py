"""
Cache das peças já separadas de cada foto da mesa.

Separar as peças de uma foto é o passo mais caro de uma busca (cerca de 3/4 do tempo) e o resultado só depende
da foto e do tamanho da peça. Como o usuário repete a busca com as mesmas fotos (uma vez por peça que procura),
guardar o resultado evita separar de novo e também reenviar a foto: o app manda só a chave dela.

A memória do plano gratuito é pequena (512 MB), então cada foto é guardada comprimida (recortes em WebP, máscaras
em PNG; cerca de 0,9 MB por foto de ~60 peças) e o cache respeita o limite PHOTO_CACHE_MB.

Descarte: ao encher, só saem as fotos paradas há mais de STALE_SECONDS; se ainda assim não couber, a foto nova deixa de
ser guardada. (Descartar sempre a mais antiga seria pior: as buscas percorrem as fotos em sequência e, com mais fotos
do que o cache comporta, cada uma sairia justo antes de ser usada de novo e nenhuma acertaria.)
"""
import hashlib
import os
import pickle
import threading
import time
from collections import OrderedDict

import cv2
import numpy as np

from paper import TablePhoto

CACHE_MB = float(os.environ.get("PHOTO_CACHE_MB", "40"))
STALE_SECONDS = float(os.environ.get("PHOTO_CACHE_STALE_S", "600"))
IMAGE_QUALITY = 90
_IMAGES = ("crop", "upright")        # BGR: WebP (metade do JPEG com a mesma qualidade)
_MASKS = ("mask", "upright_mask")    # 0/255: PNG sem perda
# O contorno só serve ao modo antigo (find-piece com foto do encaixe), que nunca lê o cache
_SKIP = ("photo", "contour")


def photo_key(data, piece_mm, max_side):
    """Chave estável da foto: o conteúdo dela mais o que muda o resultado (tamanho da peça e da imagem)."""
    mm = "x" if not piece_mm else f"{piece_mm:.2f}"
    return f"{hashlib.sha1(data).hexdigest()}-{mm}-{max_side}"


class CachedPhoto(TablePhoto):
    """Foto recuperada do cache: tem tudo que a busca usa, menos a imagem (por isso não serve para anotar fotos)."""

    image = None

    def __init__(self, meta):  # noqa: não chama TablePhoto.__init__ (ele detectaria a folha de novo)
        self.original_size = tuple(meta["original_size"])
        self.on_paper = meta["on_paper"]
        self.px_per_mm = meta["px_per_mm"]
        self._back = None if meta["back"] is None else np.array(meta["back"], np.float64)
        self.white_ref = meta["white_ref"]
        self.pieces = meta["pieces"]
        self.key = meta["key"]


def pack(photo, pieces, key):
    meta = {
        "original_size": list(photo.original_size),
        "on_paper": photo.on_paper,
        "px_per_mm": photo.px_per_mm,
        "back": None if photo._back is None else np.asarray(photo._back).tolist(),
        "white_ref": photo.white_ref,
        "pieces": photo.pieces,
        "key": key,
    }
    items = []
    for p in pieces:
        d = {}
        for k, v in p.items():
            if k in _SKIP:
                continue  # o índice da foto vale só dentro de uma requisição
            if v is None:
                d[k] = ("raw", None)
            elif k in _IMAGES:
                ok, enc = cv2.imencode(".webp", v, [cv2.IMWRITE_WEBP_QUALITY, IMAGE_QUALITY])
                if not ok:  # build do OpenCV sem WebP
                    enc = cv2.imencode(".jpg", v, [cv2.IMWRITE_JPEG_QUALITY, 95])[1]
                d[k] = ("img", enc.tobytes())
            elif k in _MASKS:
                d[k] = ("png", cv2.imencode(".png", v, [cv2.IMWRITE_PNG_COMPRESSION, 1])[1].tobytes())
            elif isinstance(v, np.ndarray):
                d[k] = ("np", v.tobytes(), v.dtype.str, v.shape)
            else:
                d[k] = ("raw", v)
        items.append(d)
    return pickle.dumps((meta, items), protocol=4)


def unpack(blob):
    meta, items = pickle.loads(blob)  # só lê o que este servidor mesmo guardou
    pieces = []
    for d in items:
        p = {}
        for k, entry in d.items():
            kind = entry[0]
            if kind in ("img", "png"):
                p[k] = cv2.imdecode(np.frombuffer(entry[1], np.uint8), cv2.IMREAD_COLOR if kind == "img" else cv2.IMREAD_GRAYSCALE)
            elif kind == "np":
                p[k] = np.frombuffer(entry[1], np.dtype(entry[2])).reshape(entry[3]).copy()
            else:
                p[k] = entry[1]
        pieces.append(p)
    return CachedPhoto(meta), pieces


class PieceCache:
    """Cache por bytes, seguro para vários pedidos ao mesmo tempo (descarte: ver o topo do arquivo)."""

    def __init__(self, max_bytes):
        self.max_bytes = int(max_bytes)
        self._items = OrderedDict()   # chave -> [blob, último uso]; a ordem é a do último uso
        self._bytes = 0
        self._lock = threading.Lock()

    def has(self, key):
        with self._lock:
            return key in self._items

    def get(self, key):
        with self._lock:
            entry = self._items.get(key)
            if entry is None:
                return None
            entry[1] = time.time()
            self._items.move_to_end(key)
            blob = entry[0]
        return unpack(blob)

    def put(self, key, photo, pieces):
        if self.max_bytes <= 0:
            return
        blob = pack(photo, pieces, key)
        if len(blob) > self.max_bytes:
            return
        now = time.time()
        with self._lock:
            old = self._items.pop(key, None)
            if old is not None:
                self._bytes -= len(old[0])
            self._items[key] = [blob, now]
            self._bytes += len(blob)
            # Libera só o que está parado: das mais antigas para as mais novas, até caber
            for k in list(self._items):
                if self._bytes <= self.max_bytes or k == key:
                    break
                if now - self._items[k][1] > STALE_SECONDS:
                    self._bytes -= len(self._items.pop(k)[0])
            if self._bytes > self.max_bytes:  # tudo em uso: a foto nova fica sem cache em vez de tirar a de outra
                self._bytes -= len(self._items.pop(key)[0])

    def stats(self):
        with self._lock:
            return {"photos": len(self._items), "mb": round(self._bytes / 1e6, 1), "limit_mb": round(self.max_bytes / 1e6, 1)}


cache = PieceCache(CACHE_MB * 1e6)


class ArtCache:
    """As últimas artes (foto da caixa já retificada) que o app mandou: ele repete a mesma arte em cada lote de cada busca."""

    def __init__(self, keep=4):
        self.keep = keep
        self._items = OrderedDict()
        self._lock = threading.Lock()

    def put(self, data):
        key = hashlib.sha1(data).hexdigest()
        with self._lock:
            self._items.pop(key, None)
            self._items[key] = data
            while len(self._items) > self.keep:
                self._items.popitem(last=False)
        return key

    def get(self, key):
        with self._lock:
            data = self._items.get(key)
            if data is not None:
                self._items.move_to_end(key)
            return data


art_cache = ArtCache()
