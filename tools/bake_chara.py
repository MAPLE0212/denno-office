"""StopWatch 用に、characters/ の完成キャラを6席分の「はんこ」（差分スプライト）として焼く。

usage: .venv/bin/python bake_chara.py c03 [c15 ...]     （サーバ server/server.js を起動しておく）
  - キャラは サーバの /charas.js から読む（DENNO_SERVER で場所を変更、既定 http://localhost:8080）
  - 出力: ../server/sprites/<cid>/<A1..B3>.bin と bake_out/<cid>_preview.png（実機の背景に6席重ねた見本）

.bin の形式（リトルエンディアン）
  "DSP1" / uint16 x, y, w, h / uint16 frames / uint16 hasBlink /
  uint32 offsets[frames * (1 + hasBlink)]  … データ部の先頭からのバイト位置（通常の frames コマ → まばたき frames コマ）
  データ部: pack6.py と同じ、行ごとのランレングス（nRuns, (skip, len, RGB565 画素…)…）を uint16 で
"""
import sys, os, re, io, json, base64, struct, time, threading, functools, http.server, urllib.request
import numpy as np
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
NM = os.path.join(ROOT, "node_modules")
OUT_PREVIEW = os.path.join(ROOT, "bake_out")
OUT_SPRITES = os.path.join(ROOT, "..", "server", "sprites")
SERVER = os.environ.get("DENNO_SERVER", "http://localhost:8080")
CAM = dict(cam=[-1.15, 1.6, 2.45], target=[0.04, 0.42, 0.0], fov=48)  # bake6.py と同じ
N = 10
THR = 14
SEAT_CODES = ["A1", "A2", "A3", "B1", "B2", "B3"]

cids = [a for a in sys.argv[1:] if re.fullmatch(r"c\d\d", a)]
if not cids:
    sys.exit(__doc__)

# キャラの組み立て部分をサーバからもらう（3D オフィスと同じもの）
with urllib.request.urlopen(f"{SERVER}/charas.js", timeout=5) as r:
    open(os.path.join(ROOT, "_charas.js"), "wb").write(r.read())

# 実機に入っている背景（office_art.h の BG_JPG）
src = open(os.path.join(ROOT, "..", "firmware", "office_art.h"), encoding="utf-8").read()
m = re.search(r"BG_JPG\[\] = \{([^}]*)\}", src)
DEVICE_BG = np.asarray(Image.open(io.BytesIO(bytes(int(v) for v in m.group(1).split(",")))).convert("RGB")).astype(int)


def rgb565_swapped(a):
    a = a.astype(np.uint16)
    v = ((a[..., 0] >> 3) << 11) | ((a[..., 1] >> 2) << 5) | (a[..., 2] >> 3)
    return ((v & 0xFF) << 8) | (v >> 8)  # LovyanGFX のスプライトと同じ並び


def rle(img, mask):
    out = []
    px = rgb565_swapped(img)
    for y in range(mask.shape[0]):
        row = mask[y]
        runs, x = [], 0
        while x < len(row):
            if row[x]:
                x0 = x
                while x < len(row) and row[x]: x += 1
                runs.append((x0, x))
            else:
                x += 1
        out.append(len(runs))
        prev = 0
        for x0, x1 in runs:
            out += [x0 - prev, x1 - x0]
            out += px[y, x0:x1].tolist()
            prev = x1
    return out


class Q(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".html": "text/html; charset=utf-8", ".js": "application/javascript"}
    def log_message(self, *a): pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8768), functools.partial(Q, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()


def route(r):
    mm = re.match(r"https://cdn\.jsdelivr\.net/npm/(three)@[^/]+/(.*)", r.request.url)
    if mm: r.fulfill(path=os.path.join(NM, mm.group(1), mm.group(2)), content_type="application/javascript")
    else: r.abort()


def to_arr(u):
    return np.asarray(Image.open(io.BytesIO(base64.b64decode(u.split(",", 1)[1]))).convert("RGB")).astype(int)


os.makedirs(OUT_PREVIEW, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width": 700, "height": 700})
    pg.on("pageerror", lambda e: print("pageerror:", e))
    pg.route(re.compile(r"https://.*"), route)

    def open_page(q):
        pg.goto(f"http://127.0.0.1:8768/bake_chara.html{q}")
        pg.wait_for_function("window.__ready === true", timeout=30000)

    def shot(**o):
        return to_arr(pg.evaluate("o => window.__bake.shot(o)", {**CAM, "N": N, **o}))

    # 背景（キャラなし）。実機の背景とほぼ同じでなければ、ずれた絵になるので止める
    open_page("")
    bg = shot(only=-1, k=0)
    diff = np.abs(bg - DEVICE_BG).mean()
    print(f"background vs device: mean abs diff {diff:.2f}")
    if diff > 4:
        Image.fromarray(bg.astype(np.uint8)).save(os.path.join(OUT_PREVIEW, "bg_mismatch.png"))
        sys.exit("背景が実機と合いません（bake_out/bg_mismatch.png を確認）")

    for cid in cids:
        t0 = time.time()
        open_page(f"?c={cid}")
        canvas = DEVICE_BG.copy()
        os.makedirs(os.path.join(OUT_SPRITES, cid), exist_ok=True)
        total = 0
        layers = {}
        for s, code in enumerate(SEAT_CODES):
            blinks = (False, True) if s >= 3 else (False,)  # まばたきは顔が見える奥の列だけ
            frames = {(bl, k): shot(only=s, k=k, blink=bl) for bl in blinks for k in range(N)}
            masks = {key: np.abs(img - bg).sum(axis=2) > THR for key, img in frames.items()}
            uni = np.any(list(masks.values()), axis=0)
            ys, xs = np.nonzero(uni)
            x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
            datas = []
            for key in sorted(frames):  # (False, 0..N-1) → (True, 0..N-1)
                mk = masks[key][y0:y1, x0:x1]
                g = mk.copy(); g[1:] |= mk[:-1]; g[:-1] |= mk[1:]; g[:, 1:] |= mk[:, :-1]; g[:, :-1] |= mk[:, 1:]  # グローの縁を1px残す
                datas.append(rle(frames[key][y0:y1, x0:x1], g))
            offs, pos = [], 0
            for d in datas:
                offs.append(pos)
                pos += len(d) * 2
            head = b"DSP1" + struct.pack("<6H", x0, y0, x1 - x0, y1 - y0, N, 1 if len(blinks) == 2 else 0)
            body = struct.pack(f"<{len(offs)}I", *offs) + b"".join(struct.pack(f"<{len(d)}H", *d) for d in datas)
            path = os.path.join(OUT_SPRITES, cid, f"{code}.bin")
            open(path, "wb").write(head + body)
            total += len(head) + len(body)
            layers[s] = (frames[(False, 3)], masks[(False, 3)])
            print(f"  {cid} {code}: rect {x0},{y0} {x1 - x0}x{y1 - y0}  {(len(head) + len(body)) / 1024:.0f} KB")
        # 見本：実機と同じく 奥(B) → 手前(A) の順に、3コマ目を実機の背景へ重ねる
        for s in (3, 4, 5, 0, 1, 2):
            img, mk3 = layers[s]
            canvas[mk3] = img[mk3]
        pv = Image.fromarray(canvas.astype(np.uint8))
        mk = Image.new("L", (466, 466), 0); ImageDraw.Draw(mk).ellipse((0, 0, 465, 465), fill=255)
        o = Image.new("RGB", (466, 466)); o.paste(pv, (0, 0), mk)
        o.save(os.path.join(OUT_PREVIEW, f"{cid}_preview.png"))
        json.dump({"cid": cid, "bakedAt": int(time.time()), "bytes": total}, open(os.path.join(OUT_SPRITES, cid, "meta.json"), "w"))
        print(f"{cid}: {total / 1024:.0f} KB, {time.time() - t0:.0f} s")
    b.close()
srv.shutdown()
