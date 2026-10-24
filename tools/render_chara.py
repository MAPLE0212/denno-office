"""Render a character page headlessly and save front / seated screenshots.
usage: python3 render_chara.py ../characters/<作成者>/<id>.html out/<id>   → out/<id>_{seated,front,face}.png
  (<id>_front.png を characters/<作成者>/ に置くと、マイページのキャラ選びに出る)
needs: npm install (tools/), pip install -r requirements.txt, playwright install chromium
"""
import sys, os, re, time, threading, http.server, functools
from playwright.sync_api import sync_playwright

page = os.path.abspath(sys.argv[1]); out = sys.argv[2]
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
root = os.path.dirname(page); nm = os.path.join(os.path.dirname(os.path.abspath(__file__)), "node_modules")
class Q(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".html": "text/html; charset=utf-8"}
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8799), functools.partial(Q, directory=root))
threading.Thread(target=srv.serve_forever, daemon=True).start()
def route(r):
    m = re.match(r"https://cdn\.jsdelivr\.net/npm/three@[^/]+/(.*)", r.request.url)
    if m: r.fulfill(path=os.path.join(nm, "three", m.group(1)), content_type="application/javascript")
    else: r.abort()
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width": 1100, "height": 760})
    pg.on("pageerror", lambda e: print("pageerror:", e))
    pg.route(re.compile(r"https://.*"), route)
    pg.goto(f"http://127.0.0.1:8799/{os.path.basename(page)}")
    time.sleep(3); pg.locator("#stage").screenshot(path=out + "_seated.png")
    pg.click("[data-pose=stand]")
    pg.evaluate("() => { const v = window.__view; v.controls.target.set(0.55, 0.5, 0.05); v.camera.position.set(0.3, 0.62, 1.35); }")
    time.sleep(2); pg.locator("#stage").screenshot(path=out + "_front.png")
    pg.evaluate("() => { const v = window.__view; v.controls.target.set(0.55, 0.66, 0.05); v.camera.position.set(0.24, 0.72, 0.9); }")
    time.sleep(2); pg.locator("#stage").screenshot(path=out + "_face.png")
    b.close()
srv.shutdown()
print("saved", out + "_{seated,front,face}.png")
