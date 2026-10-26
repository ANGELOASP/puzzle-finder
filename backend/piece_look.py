"""
Aparência de cada peça para o banco de peças: cores dominantes (em Lab, com a cor para exibir), quanto a peça varia por
dentro (liso × desenhado) e o tamanho do corpo dentro da miniatura (para montar a peça no lugar certo na montagem virtual).

É o que uma pessoa olha ao separar peças na mesa: primeiro a cor principal, depois se tem desenho ou é liso.
Não dá nome às cores: a cor das fotos muda com a luz (um verde sai "amarelo"), então o app agrupa as peças por
semelhança entre si e mostra a amostra de cada grupo. Quem separa é o app; quem batiza é você, olhando a amostra.
"""
import cv2
import numpy as np

K = 3
MIN_SHARE = 0.12      # cor que ocupa menos que isso da peça não conta
MAX_SIDE = 64


def describe(piece):
    up, mask = piece.get("upright"), piece.get("upright_mask")
    if up is None or mask is None:
        return None
    m = mask > 127
    if m.sum() < 40:
        return None
    # corpo da peça dentro da miniatura (miniatura = imagem inteira reduzida): lado do quadrado de mesma área
    body = float(np.sqrt(m.sum())) / float(max(up.shape[:2]))
    s = MAX_SIDE / float(max(up.shape[:2]))
    small = cv2.resize(up, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    sm = cv2.resize(m.astype(np.uint8), (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
    # tira a borda fina (sombra, serrilhado do recorte)
    inner = cv2.erode(sm.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    if inner.sum() >= 30:
        sm = inner
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32)
    pix = lab[sm]
    if len(pix) < 20:
        return None
    k = min(K, len(pix))
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 15, 1.0)
    cv2.setRNGSeed(3)
    _, labels, centers = cv2.kmeans(pix, k, None, crit, 2, cv2.KMEANS_PP_CENTERS)
    labels = labels.ravel()
    colors = []
    for i in range(k):
        share = float((labels == i).mean())
        if share < MIN_SHARE:
            continue
        c = np.clip(centers[i], 0, 255).astype(np.uint8)
        bgr = cv2.cvtColor(c.reshape(1, 1, 3), cv2.COLOR_LAB2BGR)[0, 0]
        colors.append({"share": round(share, 2), "lab": [round(float(v), 1) for v in centers[i]],
                       "hex": "#%02x%02x%02x" % (bgr[2], bgr[1], bgr[0])})
    colors.sort(key=lambda c: -c["share"])
    # desenho: variação de luminosidade e de cor dentro da peça (peça lisa quase não varia)
    spread = float(np.sqrt(pix.var(axis=0).sum()))
    return {
        "colors": colors[:3],
        "tone": round(float(pix[:, 0].mean()) / 255.0 * 100.0, 1),
        "spread": round(spread, 1),
        "body": round(body, 3),
    }
