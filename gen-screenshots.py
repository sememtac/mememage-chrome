#!/usr/bin/env python3
"""Generate Chrome Web Store screenshots (1280x800) from the REAL extension.

    python3 packaging/extension/gen-screenshots.py

Shots 1-3 use the genesis image (mememage-0000000000000000, the mememage.art
hero) for brand consistency; genesis is a canonical record (hash_version 1) so
the extension reads it as a calm IDENTIFIED. Shot 4 shows the core success
verdict — green VERIFIED on an open-model record (raw API / ComfyUI shape) —
so the listing demonstrates the extension's strongest signal too.

  1. genesis + the command card (IDENTIFIED)
  2. genesis + just the sticker
  3. the toolbar popup (record-source mirrors + per-source timeout)
  4. VERIFIED — a real open-model record (core encodes a sample, the extension
     confirms it by hash)

Writes PNGs to packaging/extension/store/screenshots/. Needs network.
MV3 service workers usually need a headed browser.
"""
import functools, http.server, json, os, socketserver, sys, tempfile, threading

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "store", "screenshots")
BASE_IMAGE = os.path.join(REPO, "samples", "pb2_emerald_cathedral.png")
PRODUCT = "https://mememage.art/"
HERO_PORT = 8019
W, H = 1280, 800


def build_hero_dir():
    """Encode the sample image open-model; lay out the barred image, its record
    under records/<id>.json, and a clean dark showcase page."""
    import mememage
    d = tempfile.mkdtemp(prefix="mm-hero-")
    os.makedirs(os.path.join(d, "records"))
    rec = mememage.encode(BASE_IMAGE, {"title": "Emerald Cathedral", "creator": "Catmemes"},
                          out=os.path.join(d, "art.png"))
    with open(os.path.join(d, "records", rec.identifier + ".json"), "w") as f:
        json.dump(rec.record, f)
    with open(os.path.join(d, "index.html"), "w") as f:
        f.write(
            "<!doctype html><html><head><meta charset=utf-8>"
            "<style>html,body{margin:0;height:100%;background:#08080c;}"
            ".b{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;}"
            "img{max-height:94vh;max-width:58vw;border-radius:6px;"
            "box-shadow:0 12px 64px rgba(0,0,0,.6);}"
            "</style></head><body><div class=b>"
            "<img src='art.png' alt='Emerald Cathedral'></div></body></html>")
    return d


def serve_dir(d, port):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    class TS(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
    srv = TS(("127.0.0.1", port), functools.partial(Handler, directory=d))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _verify_card(page):
    """Click the current in-frame sticker, run verify, wait for the verdict word."""
    page.evaluate("""() => {
        const root=document.querySelector('mememage-overlay');
        const on=[...root.shadowRoot.querySelectorAll('.stk.on')];
        if (on.length) on[on.length-1].click();
    }""")
    page.wait_for_selector("mememage-overlay .card [data-verify]", timeout=8000)
    page.click("mememage-overlay .card [data-verify]")
    page.wait_for_selector("mememage-overlay .card .word", timeout=15000)
    page.wait_for_timeout(500)
    return page.inner_text("mememage-overlay .card .word")


def main():
    from playwright.sync_api import sync_playwright
    os.makedirs(OUT, exist_ok=True)
    srv = serve_dir(build_hero_dir(), HERO_PORT)
    shots = []

    try:
        with sync_playwright() as p:
            profile = tempfile.mkdtemp(prefix="mm-shot-")
            ctx = sw = None
            for headless in (True, False):
                try:
                    ctx = p.chromium.launch_persistent_context(
                        profile, headless=headless, viewport={"width": W, "height": H},
                        device_scale_factor=2,
                        args=["--disable-extensions-except=" + HERE, "--load-extension=" + HERE])
                    sw = ctx.service_workers[0] if ctx.service_workers else \
                        ctx.wait_for_event("serviceworker", timeout=8000)
                    break
                except Exception as e:
                    if ctx: ctx.close(); ctx = None
                    if not headless: raise
                    print("(headless SW didn't start — retrying headed:", str(e)[:60], ")")

            sw.evaluate("() => chrome.storage.sync.set({ stickerMode: 'always', side: 'right' })")
            page = ctx.new_page()
            page.set_viewport_size({"width": W, "height": H})

            # --- Shots 1-2: genesis (product page lightbox, default souls+IA sources)
            page.goto(PRODUCT, wait_until="networkidle", timeout=45000)
            page.wait_for_timeout(2000)
            page.evaluate("() => { const b=document.getElementById('heroZoom'); if(b) b.click(); }")
            page.wait_for_timeout(800)
            page.evaluate("() => { const h=document.querySelector('.product-hero-img'); if(h) h.remove(); }")
            got = False
            for _ in range(25):
                page.wait_for_timeout(400)
                if page.evaluate("() => { const r=document.querySelector('mememage-overlay'); return r?[...r.shadowRoot.querySelectorAll('.stk.on')].length:0; }"):
                    got = True; break
            if got:
                page.wait_for_timeout(500)
                f = os.path.join(OUT, "2-sticker.png")
                page.screenshot(path=f); shots.append(f)
                _verify_card(page)          # genesis -> IDENTIFIED
                f = os.path.join(OUT, "1-card.png")
                page.screenshot(path=f); shots.append(f)
            else:
                print("WARN: genesis lightbox produced no sticker — skipping shots 1-2", file=sys.stderr)

            # --- Shot 4: VERIFIED on the local open-model record -----------------
            sw.evaluate("() => chrome.storage.sync.set({ sources: 'http://localhost:%d/records' })" % HERO_PORT)
            page.goto("http://localhost:%d/" % HERO_PORT, wait_until="networkidle", timeout=30000)
            page.wait_for_selector("mememage-overlay .stk.on", timeout=15000)
            page.wait_for_timeout(700)
            word = _verify_card(page)
            if word != "VERIFIED":
                print("WARN: shot 4 verdict is %r, expected VERIFIED" % word, file=sys.stderr)
            f = os.path.join(OUT, "4-verified.png")
            page.screenshot(path=f); shots.append(f)

            # --- Shot 3: the toolbar popup (settings) ----------------------------
            ext_id = sw.url.split("/")[2]
            pop = ctx.new_page()
            pop.set_viewport_size({"width": 360, "height": 640})
            pop.goto("chrome-extension://%s/popup.html" % ext_id)
            pop.wait_for_selector("#sources")
            pop.fill("#sources", "https://souls.mememage.art/\nhttps://archive.org/download/{id}/")
            pop.wait_for_timeout(400)
            pop.locator("body").screenshot(path=os.path.join(OUT, "_popup_raw.png"))
            pop.close()

            ctx.close()
    finally:
        srv.shutdown()

    from PIL import Image, ImageDraw, ImageFilter
    S = 2
    f3 = os.path.join(OUT, "3-popup.png")
    _composite_popup(os.path.join(OUT, "_popup_raw.png"), f3, W * S, H * S, S,
                     Image, ImageDraw, ImageFilter)
    shots.append(f3)

    for f in shots:
        im = Image.open(f)
        if im.size != (W, H):
            im.resize((W, H), Image.LANCZOS).save(f)

    print("\nwrote %d screenshots to %s" % (len(shots), OUT))
    for s in sorted(shots):
        print("  " + os.path.relpath(s, HERE))


def _composite_popup(raw_path, out_path, CW, CH, S, Image, ImageDraw, ImageFilter):
    """Center the popup panel on a dark canvas with rounded corners + a soft shadow."""
    panel = Image.open(raw_path).convert("RGBA")
    radius = 16 * S
    mask = Image.new("L", panel.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, panel.width - 1, panel.height - 1],
                                           radius=radius, fill=255)
    panel.putalpha(mask)

    canvas = Image.new("RGBA", (CW, CH), (11, 11, 17, 255))
    px = (CW - panel.width) // 2
    py = (CH - panel.height) // 2

    shadow = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    box = Image.new("RGBA", panel.size, (0, 0, 0, 0))
    box.putalpha(mask.point(lambda a: int(a * 0.5)))
    shadow.paste(Image.new("RGBA", panel.size, (0, 0, 0, 255)), (px, py + 10 * S), box)
    shadow = shadow.filter(ImageFilter.GaussianBlur(14 * S))
    canvas = Image.alpha_composite(canvas, shadow)

    canvas.alpha_composite(panel, (px, py))
    border = Image.new("RGBA", panel.size, (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle([0, 0, panel.width - 1, panel.height - 1],
                                             radius=radius, outline=(180, 180, 190, 46), width=S)
    canvas.alpha_composite(border, (px, py))

    canvas.convert("RGB").save(out_path)
    try: os.remove(raw_path)
    except OSError: pass


if __name__ == "__main__":
    main()
