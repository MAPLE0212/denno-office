import sys, os, re, json, base64, io, threading, http.server, functools
from playwright.sync_api import sync_playwright
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
NM = os.path.join(ROOT, "node_modules")
OUT = os.path.join(ROOT, "bake6_out")
os.makedirs(OUT, exist_ok=True)
CAM = dict(cam=[-1.15, 1.6, 2.45], target=[0.04, 0.42, 0.0], fov=48)
N = 10
TEST = "--test" in sys.argv

class Q(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".html": "text/html; charset=utf-8", ".js": "application/javascript"}
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8767), functools.partial(Q, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
def route(r):
    m = re.match(r"https://cdn\.jsdelivr\.net/npm/(three)@[^/]+/(.*)", r.request.url)
    if m: r.fulfill(path=os.path.join(NM, m.group(1), m.group(2)), content_type="application/javascript")
    else: r.abort()
def to_img(u): return Image.open(io.BytesIO(base64.b64decode(u.split(",", 1)[1]))).convert("RGB")

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width": 700, "height": 900})
    pg.on("pageerror", lambda e: print("pageerror:", e)); pg.on("console", lambda m: print("console:", m.text))
    pg.route(re.compile(r"https://.*"), route)
    pg.goto("http://127.0.0.1:8767/bake6.html")
    pg.wait_for_function("window.__ready === true", timeout=20000)
    shot = lambda **o: to_img(pg.evaluate("o => window.__bake.shot(o)", {**CAM, **o}))
    if TEST:
        shot(all=True, k=0, N=N, only=-1).save(os.path.join(OUT, "test_all.png"))
        b.close(); srv.shutdown(); sys.exit(0)
    shot(only=-1, k=0, N=N).save(os.path.join(OUT, "bg.png"))
    for s in range(6):
        for k in range(N):
            for blink in ((False, True) if s >= 3 else (False,)):
                shot(only=s, k=k, N=N, blink=blink).save(os.path.join(OUT, f"s{s}_{k:02d}{'_b' if blink else ''}.png"))
    shot(only=-1, k=0, N=N)  # restore camera for anchors
    anchors = pg.evaluate("() => window.__bake.anchors()")
    json.dump({"N": N, "anchors": anchors}, open(os.path.join(OUT, "meta.json"), "w"))
    b.close()
srv.shutdown()
print("baked")
