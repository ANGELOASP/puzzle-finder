"""
Banco de peças: as peças já separadas de cada foto ficam guardadas no Supabase Storage (bucket piece-banks), não só na
memória do servidor. O Render gratuito reinicia e apaga a memória; do banco, a foto volta em ~1 s em vez de ser
separada de novo (a separação é ~3/4 do tempo de uma busca).

Usa o login do próprio usuário (o app manda o token): quem lê e grava são os participantes do projeto, pelas mesmas regras
das fotos (ver supabase/banco_de_pecas.sql). Tudo é "melhor esforço": se o banco falhar, a busca segue como antes.
"""
import contextvars
import os
import re
import threading
import urllib.error
import urllib.request

import piece_cache

BUCKET = "piece-banks"
ENABLED = os.environ.get("PIECE_BANK", "true").lower() != "false"
TIMEOUT_GET = 12
TIMEOUT_PUT = 40
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
KEY = re.compile(r"^[0-9a-f]{40}-[0-9a-z.]+-[0-9]+$")

token_var = contextvars.ContextVar("bank_token", default=None)
puzzle_var = contextvars.ContextVar("bank_puzzle", default=None)
stats = {"loaded": 0, "saved": 0, "miss": 0, "errors": 0}


def configure(supabase_url, anon_key):
    global _URL, _ANON
    _URL, _ANON = supabase_url, anon_key


_URL = _ANON = None


def active():
    t, p = token_var.get(), puzzle_var.get()
    return bool(ENABLED and _URL and t and p and UUID.match(p))


def _request(method, path, token, data=None, timeout=10, extra=None):
    headers = {"Authorization": f"Bearer {token}", "apikey": _ANON}
    headers.update(extra or {})
    req = urllib.request.Request(f"{_URL}/storage/v1/object/{BUCKET}/{path}", data=data, method=method, headers=headers)
    return urllib.request.urlopen(req, timeout=timeout)


def load(key):
    """Traz a foto do banco para o cache em memória. True se achou e era válida."""
    if not active() or not KEY.match(key):
        return False
    path = f"{puzzle_var.get()}/{key}.zip"
    try:
        with _request("GET", path, token_var.get(), timeout=TIMEOUT_GET) as r:
            data = r.read(70 * 1024 * 1024)
        blob = piece_cache.from_safe(data)
    except urllib.error.HTTPError as err:
        stats["miss" if err.code in (400, 404) else "errors"] += 1
        return False
    except (OSError, ValueError):
        stats["errors"] += 1
        return False
    if piece_cache.cache.put_blob(key, blob):
        stats["loaded"] += 1
        return True
    return False


def save_async(key):
    """Grava a foto (já no cache) no banco, em segundo plano: a busca não espera por isso."""
    if not active() or not KEY.match(key):
        return
    blob = piece_cache.cache.get_blob(key)
    if blob is None:
        return
    token, path = token_var.get(), f"{puzzle_var.get()}/{key}.zip"

    def work():
        try:
            data = piece_cache.to_safe(blob)
            with _request("POST", path, token, data=data, timeout=TIMEOUT_PUT,
                          extra={"Content-Type": "application/zip", "x-upsert": "true"}):
                stats["saved"] += 1
        except Exception:  # noqa: o banco é um extra
            stats["errors"] += 1

    threading.Thread(target=work, daemon=True).start()
