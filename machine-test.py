#!/usr/bin/env python3
"""Machine test: load the REAL extension into Chromium and drive it against the live
test page — real MV3 service worker, real content script, real SDK decode of real
Python-minted PNGs (including a genuine TWO-bar composite), real record fetches.

    python3 packaging/extension/machine-test.py

Covers the command-card model plus the multi-bar / centered / hover / window-aware
behaviors: a sticker per bar centered on the bar, above it; hover-only display
(default); per-bar verdicts; fetch link; click-away; no-bar vs couldn't-read
diagnostics; viewport clamping as the card grows; the toolbar popup settings surface.
"""
import os, re, socket, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
TP = os.path.join(HERE, "testpage")
PORT = 8017

fails = []
def check(name, ok):
    print(("PASS " if ok else "FAIL ") + name)
    if not ok:
        fails.append(name)


def main():
    from playwright.sync_api import sync_playwright

    srv = subprocess.Popen([sys.executable, os.path.join(HERE, "testserver.py"), str(PORT)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", PORT), 0.2).close(); break
            except OSError:
                time.sleep(0.1)

        with sync_playwright() as p:
            profile = tempfile.mkdtemp(prefix="mm-ext-")
            ctx = sw = None
            for headless in (True, False):     # MV3 SW usually needs headed; try headless first
                try:
                    ctx = p.chromium.launch_persistent_context(
                        profile, headless=headless,
                        args=["--disable-extensions-except=" + HERE, "--load-extension=" + HERE])
                    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=8000)
                    break
                except Exception as e:
                    if ctx: ctx.close(); ctx = None
                    if not headless: raise
                    print("(headless couldn't start the extension SW — retrying headed:", str(e)[:60], ")")
            check("extension service worker started", sw is not None)

            def setcfg(js_obj):
                sw.evaluate("() => chrome.storage.sync.set(%s)" % js_obj)

            setcfg("{ source: 'http://localhost:%d/records', stickerMode: 'always' }" % PORT)

            # Phase-2 event API: a MAIN-WORLD recorder, injected before any page loads,
            # so it catches the extension's mememage:detected / :removed DOM events (they
            # cross the content-script/page world boundary via the shared DOM). Proves the
            # cross-world delivery + that detail is readable in the page.
            ctx.add_init_script("""
                window.__mmDetected = [];
                addEventListener('mememage:detected', function (e) {
                    var b = e.detail && e.detail.bars && e.detail.bars[0];
                    window.__mmDetected.push({ id: b && b.identifier, hash: b && b.contentHash,
                        n: (e.detail && e.detail.bars) ? e.detail.bars.length : 0, hasDetail: !!e.detail });
                }, true);
                window.__mmRemoved = 0;
                addEventListener('mememage:removed', function () { window.__mmRemoved++; }, true);
            """)

            page = ctx.new_page()
            page.set_viewport_size({"width": 1100, "height": 900})
            page.goto("http://localhost:%d/" % PORT)
            page.wait_for_selector("mememage-overlay .stk.on", timeout=15000)
            page.wait_for_timeout(1500)        # let all lazy scans settle

            def badges():
                return page.query_selector_all("mememage-overlay .stk.on")
            def n_badges():
                return page.eval_on_selector_all("mememage-overlay .stk",
                    "els => els.filter(e => e.classList.contains('on')).length")

            # a badge per bar in the grid at the top: verified/altered/canonical (1 each)
            # + multibar (TWO) = 5 (off-screen images' badges hide, so measure at top)
            check("a badge per bar in the grid (5, incl. multibar's 2)", n_badges() >= 5)
            src0 = page.get_attribute("mememage-overlay .stk >> nth=0", "src") or ""
            check("sticker uses the brand icon", "icons/icon32.png" in src0)

            # placement: every badge's center-x sits on the MIDDLE of the chosen color
            # barrier — 12px (native) in from the image edge, scaled to display.
            def on_barrier(side):
                imgs = page.evaluate("""() => [...document.querySelectorAll('.grid img')].map(i => {
                    const r = i.getBoundingClientRect();
                    const sx = r.width / i.naturalWidth;
                    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                             lx: r.left + 12*sx, rx: r.right - 12*sx };
                })""")
                ok = 0
                for el in badges():
                    b = el.bounding_box()
                    if not b: continue
                    bcx = b["x"] + b["width"] / 2
                    for im in imgs:
                        want = im["lx"] if side == "left" else im["rx"]
                        if abs(bcx - want) < 2 and b["y"] >= im["top"] - 2 and b["y"] <= im["bottom"]:
                            ok += 1; break
                return ok
            check("stickers on the RIGHT barrier middle (default)", on_barrier("right") == 5)
            setcfg("{ side: 'left' }")
            page.wait_for_timeout(500)
            check("side=left moves them to the LEFT barrier middle", on_barrier("left") == 5)
            setcfg("{ side: 'right' }")
            page.wait_for_timeout(400)

            # letterbox (object-fit:contain): the sticker must sit on the RENDERED image's
            # barrier, inset from the element edge by the pillarbox margin — the mint.
            # mememage.art large-format bug.
            page.evaluate("() => document.getElementById('letterbox').scrollIntoView({block:'center'})")
            page.wait_for_timeout(700)
            lb = page.evaluate("""() => {
                const img = document.getElementById('letterbox');
                const r = img.getBoundingClientRect();
                const nar = img.naturalWidth/img.naturalHeight, bar = r.width/r.height;
                let rw, rh;
                if (bar > nar) { rh = r.height; rw = rh*nar; } else { rw = r.width; rh = rw/nar; }
                const renderRight = r.left + (r.width-rw)/2 + rw;
                const sx = rw / img.naturalWidth;
                const want = renderRight - 12*sx;              // barrier middle on the rendered image
                const elementEdge = r.right - 12*sx;           // the WRONG spot (element box)
                const bottom = r.top + (r.height-rh)/2 + rh;
                const stks = [...document.querySelector('mememage-overlay').shadowRoot.querySelectorAll('.stk.on')];
                let best = null, bestd = 1e9;
                for (const e of stks) { const b = e.getBoundingClientRect();
                    if (b.y+8 < bottom - 40 || b.y+8 > bottom + 20) continue;
                    const cx = b.x + b.width/2, d = Math.abs(cx - want);
                    if (d < bestd) { bestd = d; best = cx; } }
                return { best, want, elementEdge, margin: r.right - renderRight };
            }""")
            check("letterbox: sticker on the rendered image's barrier (not the element edge), margin ~%d" % round(lb["margin"]),
                  lb["best"] is not None and abs(lb["best"] - lb["want"]) < 3
                  and abs(lb["best"] - lb["elementEdge"]) > 30)

            # every lightbox-repro geometry (pillarbox multibar, letterbox, big-margin):
            # each image's stickers land on ITS rendered barrier, never the element edge
            n_lb = len(page.query_selector_all(".lbimg"))
            all_ok = True; details = []
            for i in range(n_lb):
                page.evaluate("(i) => document.querySelectorAll('.lbimg')[i].scrollIntoView({block:'center'})", i)
                page.wait_for_timeout(700)
                res = page.evaluate("""(i) => {
                    const img = document.querySelectorAll('.lbimg')[i];
                    const r = img.getBoundingClientRect();
                    const nar=img.naturalWidth/img.naturalHeight, bar=r.width/r.height; let rw,rh;
                    if(bar>nar){rh=r.height;rw=rh*nar;}else{rw=r.width;rh=rw/nar;}
                    const rl=r.left+(r.width-rw)/2, rt=r.top+(r.height-rh)/2, sx=rw/img.naturalWidth;
                    const barrier=rl+rw-12*sx, elemEdge=r.right-12*sx;
                    const root=document.querySelector('mememage-overlay').shadowRoot;
                    const mine=[...root.querySelectorAll('.stk.on')].map(e=>{const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})
                        .filter(s=>s.x>=rl-6&&s.x<=rl+rw+6&&s.y>=rt-6&&s.y<=rt+rh+6);
                    const onBarrier = mine.length>0 && mine.every(s=>Math.abs(s.x-barrier)<3);
                    return {margin:Math.round(r.width-rw), n:mine.length, onBarrier,
                            sepFromEdge:Math.round(Math.abs(barrier-elemEdge))};
                }""", i)
                if not res or not res["onBarrier"]:
                    all_ok = False
                details.append(res)
            check("all lightbox geometries: stickers on rendered barrier — " + str(details), all_ok)

            # RESOLUTION MISMATCH: the SW decodes mismatch.png at 800x1200 (fetch), the
            # <img> displays it at 600px tall. The sticker must land on the rendered
            # image's bottom bar via fraction mapping — NOT fly off using naturalHeight.
            page.evaluate("() => document.getElementById('mismatch').scrollIntoView({block:'center'})")
            page.wait_for_timeout(1000)
            mm = page.evaluate("""() => {
                const img = document.getElementById('mismatch');
                const r = img.getBoundingClientRect();
                // barrier 12px from the DISPLAY's native edge (barrier ~24px at nat res)
                const barrierX = r.right - 12 * (r.width / img.naturalWidth);
                const root = document.querySelector('mememage-overlay').shadowRoot;
                const mine = [...root.querySelectorAll('.stk.on')].map(e=>{const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})
                    .filter(s => s.x>=r.left-6 && s.x<=r.right+6 && s.y>=r.top-40 && s.y<=r.bottom+40);
                return {natW: img.naturalWidth, natH: img.naturalHeight,
                        imgBottom: Math.round(r.bottom), barrierX: Math.round(barrierX),
                        stickers: mine.map(s=>({x:Math.round(s.x),y:Math.round(s.y)}))};
            }""")
            # SW decodes 768x768, browser displays 1024x1024 (natW=1024). Vertical: the
            # fraction fix keeps the sticker on the rendered bottom bar. Horizontal: the
            # barrier steps in 12px scaled by naturalWidth (1024), NOT the SW width (768)
            # — the few-px drift Andy saw on large images.
            on_bar = (len(mm["stickers"]) == 1
                      and abs(mm["stickers"][0]["y"] - mm["imgBottom"]) < 30
                      and abs(mm["stickers"][0]["x"] - mm["barrierX"]) < 3)
            check("resolution mismatch: sticker on the barrier, both axes (natW=%s barrierX=%s stickers=%s)"
                  % (mm["natW"], mm["barrierX"], mm["stickers"]), on_bar)

            # OFFSET BAR: pasted into a 900px canvas at x 230..730. The sticker's
            # right-barrier must land at (730-12)/900 of the rendered width — INSIDE the
            # canvas — not at the canvas right edge.
            page.evaluate("() => document.getElementById('offset').scrollIntoView({block:'center'})")
            page.wait_for_timeout(1000)
            ob = page.evaluate("""() => {
                const img = document.getElementById('offset');
                const r = img.getBoundingClientRect();
                const scale = r.width / img.naturalWidth;    // display px per canvas px
                const barrierX = r.left + 717 * scale;        // detected right barrier ~729-12
                const canvasEdge = r.right - 12 * scale;      // the WRONG spot
                const root = document.querySelector('mememage-overlay').shadowRoot;
                const mine = [...root.querySelectorAll('.stk.on')].map(e=>{const b=e.getBoundingClientRect();return b.x+b.width/2;})
                    .filter(x => x>=r.left-6 && x<=r.right+6);
                let best=null, d=1e9; for(const x of mine){const dd=Math.abs(x-barrierX); if(dd<d){d=dd;best=x;}}
                return {best: best!=null?Math.round(best):null, barrierX:Math.round(barrierX), canvasEdge:Math.round(canvasEdge)};
            }""")
            check("offset bar: sticker on the bar's barrier inside the canvas, not the edge (barrier@%s edge@%s sticker@%s)"
                  % (ob["barrierX"], ob["canvasEdge"], ob["best"]),
                  ob["best"] is not None and abs(ob["best"] - ob["barrierX"]) < 6
                  and abs(ob["best"] - ob["canvasEdge"]) > 30)

            # TRANSITION FOLLOW: shrink the image; the sticker must re-place quickly
            # (ResizeObserver), not lag until the 1200ms interval — the frame-or-two
            # misplacement Andy saw on lightbox size-up.
            def offset_sticker():
                return page.evaluate("""() => {
                    const img = document.getElementById('offset'), r = img.getBoundingClientRect();
                    const barrier = r.left + 717*(r.width/img.naturalWidth);
                    const root = document.querySelector('mememage-overlay').shadowRoot;
                    const s = [...root.querySelectorAll('.stk.on')].map(e=>{const b=e.getBoundingClientRect();return b.x+b.width/2;})
                        .filter(x => x>=r.left-8 && x<=r.right+8);
                    return {barrier: Math.round(barrier), sticker: s.length?Math.round(s[0]):null};
                }""")
            before = offset_sticker()
            page.evaluate("() => document.getElementById('offset').style.width='300px'")   # shrink
            page.wait_for_timeout(120)                                                       # << the 1200ms interval
            after = offset_sticker()
            check("transition follow: sticker re-places on resize within ~120ms (barrier@%s sticker@%s, was @%s)"
                  % (after["barrier"], after["sticker"], before["sticker"]),
                  after["sticker"] is not None and abs(after["sticker"] - after["barrier"]) < 4
                  and after["sticker"] < before["sticker"] - 20)
            page.evaluate("() => document.getElementById('offset').style.width='600px'")     # restore
            page.wait_for_timeout(120)

            # OBJECT-POSITION: a wide image pillarboxed left / right. The sticker must
            # follow the image's rendered right-barrier, NOT sit in the empty margin.
            pos_ok = True; pos_detail = []
            for pid in ("left", "right"):
                page.evaluate("""(side) => {
                    const el = [...document.querySelectorAll('.lbposimg')].find(i => getComputedStyle(i).objectPosition.startsWith(side==='left'?'0%':'100%'));
                    if (el) el.scrollIntoView({block:'center'});
                }""", pid)
                page.wait_for_timeout(800)
                r = page.evaluate("""(side) => {
                    const img = [...document.querySelectorAll('.lbposimg')].find(i => getComputedStyle(i).objectPosition.startsWith(side==='left'?'0%':'100%'));
                    const r = img.getBoundingClientRect();
                    const nar = img.naturalWidth/img.naturalHeight;
                    const rw = r.height*nar;                    // pillarbox: fits height
                    const px = side==='left' ? 0 : 1;
                    const rl = r.left + (r.width-rw)*px;
                    const barrier = rl + rw - 12*(rw/img.naturalWidth);
                    const root = document.querySelector('mememage-overlay').shadowRoot;
                    const mine = [...root.querySelectorAll('.stk.on')].map(e=>{const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})
                        .filter(s => s.y>=r.top-4 && s.y<=r.bottom+4);
                    let near=null,d=1e9; for(const s of mine){const dd=Math.abs(s.x-barrier); if(dd<d){d=dd;near=s.x;}}
                    return {barrier:Math.round(barrier), sticker:near!=null?Math.round(near):null, rl:Math.round(rl), rw:Math.round(rw)};
                }""", pid)
                ok = r["sticker"] is not None and abs(r["sticker"] - r["barrier"]) < 6
                if not ok: pos_ok = False
                pos_detail.append((pid, r))
            check("object-position: sticker follows the image, not the margin — " + str(pos_detail), pos_ok)

            # TOP-OF-FRAME BAR: placing the sticker above it would clip off the top, so it
            # must flip below and slide down — staying fully inside the image.
            page.evaluate("() => document.getElementById('topbar').scrollIntoView({block:'center'})")
            page.wait_for_timeout(900)
            tb = page.evaluate("""() => {
                const img = document.getElementById('topbar');
                const r = img.getBoundingClientRect();
                const barTopY = r.top + ((21-2)/img.naturalHeight)*r.height;   // bar top in the frame
                const root = document.querySelector('mememage-overlay').shadowRoot;
                const st = [...root.querySelectorAll('.stk.on')].map(e=>({b:e.getBoundingClientRect(), down:e.classList.contains('down')}))
                    .filter(o => o.b.x+o.b.width/2 >= r.left-8 && o.b.x+o.b.width/2 <= r.right+8);
                if (!st.length) return {none:true};
                const s = st[0];
                return { imgTop: Math.round(r.top), stickerTop: Math.round(s.b.y), stickerBottom: Math.round(s.b.y+s.b.height),
                         barTopY: Math.round(barTopY), down: s.down };
            }""")
            # the sticker must NOT clip above the image, must be flagged .down, and must
            # sit BELOW the bar (not above it)
            check("top bar: sticker flips below & stays in-canvas (down=%s, stickerTop=%s>=imgTop=%s, below bar=%s)"
                  % (tb.get("down"), tb.get("stickerTop"), tb.get("imgTop"), tb.get("stickerTop",0) > tb.get("barTopY",0)),
                  (not tb.get("none")) and tb["down"] is True
                  and tb["stickerTop"] >= tb["imgTop"] - 1
                  and tb["stickerTop"] > tb["barTopY"])
            page.evaluate("() => window.scrollTo(0,0)")
            page.wait_for_timeout(400)

            # DYNAMIC <img>: the two common real-web patterns must sticker.
            def stickers_over(el_id):
                return page.evaluate("""(id) => {
                    const el = document.getElementById(id); if(!el) return -1;
                    const r = el.getBoundingClientRect();
                    const root = document.querySelector('mememage-overlay').shadowRoot;
                    return [...root.querySelectorAll('.stk.on')].filter(e=>{const b=e.getBoundingClientRect();
                        return b.x+8>=r.left-8 && b.x+8<=r.right+8 && b.y>=r.top-30 && b.y<=r.bottom+30;}).length;
                }""", el_id)
            base = "http://localhost:%d/img/" % PORT
            # lazy-load: an <img> inserted blank, real (barred) src set a beat later
            page.evaluate("""(base) => { const i=document.createElement('img'); i.id='mm-lazy';
                i.style.cssText='width:440px;display:block;margin-top:24px'; document.body.appendChild(i);
                i.scrollIntoView({block:'center'});
                setTimeout(()=>{ i.src = base+'altered.png'; }, 300); }""", base)
            page.wait_for_timeout(1600)
            check("lazy-load: <img> with src set after insert gets stickered (%s)" % stickers_over('mm-lazy'),
                  stickers_over('mm-lazy') == 1)
            # carousel: an <img> showing a non-bar image, then swapped to a barred one
            page.evaluate("""(base) => { const i=document.createElement('img'); i.id='mm-carousel';
                i.style.cssText='width:440px;display:block;margin-top:24px'; i.src = base+'plain.png';
                document.body.appendChild(i); i.scrollIntoView({block:'center'}); }""", base)
            page.wait_for_timeout(1300)
            before_c = stickers_over('mm-carousel')       # plain.png has no bar
            page.evaluate("(base) => document.getElementById('mm-carousel').src = base+'canonical.png'", base)
            page.wait_for_timeout(1600)
            after_c = stickers_over('mm-carousel')
            check("carousel: sticker appears after src swaps to a barred image (before=%s after=%s)" % (before_c, after_c),
                  before_c == 0 and after_c == 1)
            page.evaluate("() => { ['mm-lazy','mm-carousel'].forEach(id=>{const e=document.getElementById(id); if(e)e.remove();}); window.scrollTo(0,0); }")
            page.wait_for_timeout(300)

            # NEW SURFACES: <canvas> (re-encoded to a data URL for the SW) and CSS
            # background-image (SW fetches the bg URL) now get stickered too.
            page.evaluate("() => document.getElementById('cv').scrollIntoView({block:'center'})")
            page.wait_for_timeout(1800)   # toDataURL -> SW fetch/decode (+ retry)
            check("canvas: mememage drawn to <canvas> gets stickered (%s bars)" % stickers_over('cv'),
                  stickers_over('cv') == 2)
            page.evaluate("() => document.getElementById('bgdiv').scrollIntoView({block:'center'})")
            page.wait_for_timeout(1400)
            check("background-image: CSS-background mememage gets stickered (%s)" % stickers_over('bgdiv'),
                  stickers_over('bgdiv') == 1)

            # Phase-2 event API: the page's main-world listener received mememage:detected
            # with readable detail (identifier + hash), proving cross-world delivery.
            ev = page.evaluate("""() => {
                var d = (window.__mmDetected || []).filter(function (x) { return x.id && x.hasDetail; });
                return { count: d.length, sample: d[0] || null, removed: window.__mmRemoved || 0 };
            }""")
            check("event API: page receives mememage:detected with detail (%s events, sample id=%s)"
                  % (ev["count"], ev["sample"] and ev["sample"]["id"]),
                  ev["count"] >= 3 and ev["sample"] and ev["sample"]["id"].startswith("mememage-")
                  and len(ev["sample"]["hash"]) == 16)
            # mememage:removed fires when a DETECTED image's src changes away.
            page.evaluate("""(base) => {
                const i = document.createElement('img'); i.id = 'mm-rem';
                i.style.cssText = 'width:440px;display:block;margin-top:24px';
                document.body.appendChild(i); i.scrollIntoView({block:'center'});
                i.src = base + 'verified.png';
            }""", base)
            page.wait_for_timeout(1500)                       # detected
            before_rem = page.evaluate("() => window.__mmRemoved || 0")
            page.evaluate("(base) => document.getElementById('mm-rem').src = base + 'canonical.png'", base)
            page.wait_for_timeout(1500)                       # src change -> removed
            after_rem = page.evaluate("() => window.__mmRemoved || 0")
            check("event API: mememage:removed fires on a detected image's src change (%s->%s)" % (before_rem, after_rem),
                  after_rem > before_rem)
            page.evaluate("() => { const e=document.getElementById('mm-rem'); if(e)e.remove(); window.scrollTo(0,0); }")
            page.wait_for_timeout(300)
            # preventDefault() on mememage:detected suppresses our default sticker.
            page.evaluate("""(base) => {
                const i = document.createElement('img'); i.id = 'mm-sup';
                i.style.cssText = 'width:440px;display:block;margin-top:24px';
                i.addEventListener('mememage:detected', function (e) { e.preventDefault(); });
                document.body.appendChild(i); i.scrollIntoView({block:'center'});
                i.src = base + 'verified.png';
            }""", base)
            page.wait_for_timeout(1700)
            sup = stickers_over('mm-sup')
            supfired = page.evaluate("() => (window.__mmDetected||[]).some(x => x.id && x.id.startsWith('mememage-'))")
            check("event API: preventDefault suppresses the sticker (stickers=%s, event still fired=%s)" % (sup, supfired),
                  sup == 0 and supfired)
            page.evaluate("() => { const e=document.getElementById('mm-sup'); if(e)e.remove(); window.scrollTo(0,0); }")
            page.wait_for_timeout(300)
            # blob: <img> (createObjectURL) — the decoder's own preview + lightbox case,
            # and any app that previews a locally-selected file. A blob URL is page-scoped,
            # so the SW can't fetch it; the content script re-encodes the loaded <img> to a
            # data URL. Fetch a barred PNG, wrap it in a blob URL, expect one sticker.
            page.evaluate("""(base) => {
                const i = document.createElement('img'); i.id = 'mm-blob';
                i.style.cssText = 'width:440px;display:block;margin-top:24px';
                document.body.appendChild(i); i.scrollIntoView({block:'center'});
                fetch(base+'verified.png').then(r=>r.blob()).then(b=>{ i.src = URL.createObjectURL(b); });
            }""", base)
            page.wait_for_timeout(1700)
            check("blob: <img> (createObjectURL) gets stickered — decoder preview/lightbox (%s)" % stickers_over('mm-blob'),
                  stickers_over('mm-blob') == 1)
            page.evaluate("() => { const e=document.getElementById('mm-blob'); if(e)e.remove(); window.scrollTo(0,0); }")
            page.wait_for_timeout(300)
            page.evaluate("() => window.scrollTo(0,0)")
            page.wait_for_timeout(300)

            def card_ident():
                page.wait_for_selector("mememage-overlay .card .idl b", timeout=15000)
                return page.inner_text("mememage-overlay .card .idl b")

            # 1. sticker click -> MINIMAL command card, no auto-verdict
            badges()[0].click()
            ident = card_ident()
            check("command card shows identifier (no auto-verdict)",
                  ident.startswith("mememage-") and not page.query_selector("mememage-overlay .card .word"))
            check("commands offered: verify / fetch record / options",
                  all(page.query_selector("mememage-overlay .card [data-%s]" % b) for b in ("verify", "fetch", "opts")))
            page.mouse.click(10, 10)
            page.wait_for_timeout(150)
            check("click-away dismisses the card", page.query_selector("mememage-overlay .card") is None)

            # 2. MULTI-BAR: the two badges on multibar.png carry DIFFERENT identifiers,
            #    and each verifies to its own record (both VERIFIED)
            def multibar_badges():
                return page.evaluate("""() => {
                    const img = [...document.querySelectorAll('.grid img')].find(i => i.src.includes('multibar'));
                    const r = img.getBoundingClientRect();
                    const bx = r.right - 12*(r.width/img.naturalWidth);   // right barrier middle
                    return [...document.querySelector('mememage-overlay').shadowRoot.querySelectorAll('.stk.on')]
                      .map((e,i) => { const b = e.getBoundingClientRect();
                                      return { i, x: b.x+b.width/2, y: b.y }; })
                      .filter(b => Math.abs(b.x - bx) < 2 && b.y >= r.top - 2 && b.y <= r.bottom)
                      .sort((a,b)=>a.y-b.y);
                }""")
            mb = multibar_badges()
            check("multibar image has TWO stacked badges", len(mb) == 2)
            idents = []
            verdicts = []
            for entry in mb:
                page.query_selector_all("mememage-overlay .stk.on")[entry["i"]].click()
                idents.append(card_ident())
                page.click("mememage-overlay .card [data-verify]")
                page.wait_for_selector("mememage-overlay .card .word", timeout=15000)
                verdicts.append(page.inner_text("mememage-overlay .card .word"))
                page.keyboard.press("Escape"); page.wait_for_timeout(120)
            check("the two bars have DIFFERENT identifiers", len(set(idents)) == 2)
            check("both multibar bars verify VERIFIED", verdicts == ["VERIFIED", "VERIFIED"])

            # ACTIVE STICKER: click one of the multibar stickers, then move the mouse off
            # the image (hover mode). The clicked one must STAY, its sibling must hide.
            setcfg("{ stickerMode: 'hover' }")
            page.mouse.move(10, 850); page.wait_for_timeout(400)
            page.evaluate("() => [...document.querySelectorAll('.grid img')].find(i=>i.src.includes('multibar')).scrollIntoView({block:'center'})")
            page.wait_for_timeout(400)
            page.hover("img[src*='multibar']")   # reveal both multibar stickers
            page.wait_for_timeout(300)
            def multibar_on():
                return page.evaluate("""() => {
                    const img = [...document.querySelectorAll('.grid img')].find(i=>i.src.includes('multibar'));
                    const r = img.getBoundingClientRect(), bx = r.right - 12*(r.width/img.naturalWidth);
                    return [...document.querySelector('mememage-overlay').shadowRoot.querySelectorAll('.stk.on')]
                        .filter(e=>{const b=e.getBoundingClientRect();return Math.abs(b.x+b.width/2-bx)<3 && b.y>=r.top-4 && b.y<=r.bottom;}).length;
                }""")
            check("hover reveals both multibar stickers", multibar_on() == 2)
            page.evaluate("""() => {
                const img = [...document.querySelectorAll('.grid img')].find(i=>i.src.includes('multibar'));
                const r = img.getBoundingClientRect(), bx = r.right - 12*(r.width/img.naturalWidth);
                const stks = [...document.querySelector('mememage-overlay').shadowRoot.querySelectorAll('.stk.on')]
                    .filter(e=>{const b=e.getBoundingClientRect();return Math.abs(b.x+b.width/2-bx)<3 && b.y>=r.top-4 && b.y<=r.bottom;})
                    .sort((a,b)=>a.getBoundingClientRect().y-b.getBoundingClientRect().y);
                stks[0].click();                 // click the TOP bar's sticker
            }""")
            page.wait_for_selector("mememage-overlay .card .idl b", timeout=8000)
            page.mouse.move(10, 850)             # move well off the image
            page.wait_for_timeout(500)           # past the hover grace + settle
            check("active sticker stays after mouseleave; sibling hides (visible=%s, expect 1)" % multibar_on(),
                  multibar_on() == 1)
            page.keyboard.press("Escape")        # dismiss -> the held one follows hover again
            page.wait_for_timeout(400)
            check("dismiss releases the held sticker (visible=%s, expect 0 off-image)" % multibar_on(),
                  multibar_on() == 0)
            setcfg("{ stickerMode: 'always' }")
            page.wait_for_timeout(400)

            # HOVER = uniform grow, NO vertical shift (so the cursor stays over the sticker).
            # Move the mouse to an IN-VIEWPORT sticker's center (page.hover can't scroll a
            # fixed overlay into view), then poll until the springy scale settles to ~1.1.
            page.evaluate("() => window.scrollTo(0,0)"); page.wait_for_timeout(500)
            page.mouse.move(10, 850); page.wait_for_timeout(300)
            tgt = page.evaluate("""() => {
                const root = document.querySelector('mememage-overlay').shadowRoot;
                const el = [...root.querySelectorAll('.stk.on')].find(e=>{const b=e.getBoundingClientRect();
                    return b.top>=0 && b.bottom<=innerHeight && b.left>=0 && b.right<=innerWidth;});
                if(!el) return null; const b=el.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};
            }""")
            hover_ok = False; last = None
            if tgt:
                page.mouse.move(tgt["x"], tgt["y"])
                for _ in range(20):
                    page.wait_for_timeout(60)
                    last = page.evaluate("""() => {
                        const el = document.querySelector('mememage-overlay').shadowRoot.querySelector('.stk.on:hover');
                        return el ? getComputedStyle(el).transform : null;
                    }""")
                    m = re.match(r"matrix\(([^)]+)\)", last or "")
                    if m:
                        v = [float(x) for x in m.group(1).split(",")]
                        if v[0] >= 1.08 and abs(v[4]) < 0.5 and abs(v[5]) < 0.5:   # scaled ~1.1, no tx/ty
                            hover_ok = True; break
            check("hover grows uniformly to ~1.1, no translate (%s)" % last, hover_ok)

            # 3. the three single-bar verdicts still work (VERIFIED/ALTERED/IDENTIFIED)
            def verify_image(substr):
                page.evaluate("""(s) => {
                    const img = [...document.querySelectorAll('.grid img')].find(i => i.src.includes(s));
                    const r = img.getBoundingClientRect(), bx = r.right - 12*(r.width/img.naturalWidth);
                    const stks = [...document.querySelector('mememage-overlay').shadowRoot.querySelectorAll('.stk.on')];
                    const el = stks.find(e => { const b = e.getBoundingClientRect();
                        return Math.abs(b.x+b.width/2 - bx) < 2 && b.y >= r.top-2 && b.y <= r.bottom; });
                    el.click();
                }""", substr)
                card_ident()
                page.click("mememage-overlay .card [data-verify]")
                page.wait_for_selector("mememage-overlay .card .word", timeout=15000)
                w = page.inner_text("mememage-overlay .card .word")
                page.keyboard.press("Escape"); page.wait_for_timeout(120)
                return w
            got = {s: verify_image(s) for s in ("verified", "altered", "canonical")}
            check("single-bar verdicts VERIFIED/ALTERED/IDENTIFIED: " + str(got),
                  got == {"verified": "VERIFIED", "altered": "ALTERED", "canonical": "IDENTIFIED"})

            # 4. fetch record -> open-record link
            badges()[0].click(); card_ident()
            page.click("mememage-overlay .card [data-fetch]")
            page.wait_for_selector("mememage-overlay .card .out a", timeout=15000)
            href = page.get_attribute("mememage-overlay .card .out a", "href") or ""
            check("fetch record yields an open-record link into the source", "/records/mememage-" in href)
            page.keyboard.press("Escape")

            # 5. plain image: no sticker; right-click -> no-bar; unfetchable -> couldn't-read
            def rc(url):
                sw.evaluate("""async () => {
                    const tabs = await chrome.tabs.query({});
                    const tab = tabs.find(t => (t.url||'').includes('localhost:%d'));
                    chrome.tabs.sendMessage(tab.id, { t: 'mm-verify-at', url: '%s' });
                }""" % (PORT, url))
            rc("http://localhost:%d/img/plain.png" % PORT)
            page.wait_for_selector("mememage-overlay .card .plain", timeout=15000)
            check("right-click plain image -> no-bar card",
                  "no mememage bar" in page.inner_text("mememage-overlay .card .plain").lower())
            page.keyboard.press("Escape")
            rc("http://localhost:%d/img/missing.png" % PORT)
            page.wait_for_selector("mememage-overlay .card .plain", timeout=15000)
            check("unfetchable image -> couldn't-read card (not no-bar)",
                  "read this image" in page.inner_text("mememage-overlay .card .plain"))
            page.keyboard.press("Escape")

            # 6. hover mode (default): hidden at rest, one image's badge(s) on hover
            page.mouse.move(10, 600)
            setcfg("{ stickerMode: 'hover' }")
            page.wait_for_timeout(500)
            check("hover mode: stickers hidden at rest", n_badges() == 0)
            page.hover(".grid figure >> nth=0 >> img")
            page.wait_for_timeout(300)
            check("hover mode: hovering an image reveals its sticker", n_badges() == 1)
            page.mouse.move(10, 600)
            page.wait_for_timeout(400)
            check("hover mode: leaving hides it again", n_badges() == 0)
            setcfg("{ stickerMode: 'always' }")
            page.wait_for_timeout(400)

            # 7. window-aware card near the bottom edge, re-clamps as it grows
            page.evaluate("""() => {
                const imgs = [...document.querySelectorAll('.grid img')];
                const last = imgs[imgs.length - 1];
                last.scrollIntoView();
                window.scrollBy(0, last.getBoundingClientRect().bottom - innerHeight + 30);
            }""")
            page.wait_for_timeout(600)
            b = badges(); b[len(b) - 1].click(); card_ident()
            def card_in_viewport():
                m = page.evaluate("""() => {
                    const c = document.querySelector('mememage-overlay').shadowRoot.querySelector('.card');
                    const r = c.getBoundingClientRect();
                    return { t: r.top, b: r.bottom, l: r.left, rt: r.right, ih: innerHeight, iw: innerWidth };
                }""")
                return m["t"] >= 0 and m["l"] >= 0 and m["b"] <= m["ih"] + 1 and m["rt"] <= m["iw"] + 1
            check("card opened near the bottom stays in the viewport", card_in_viewport())
            page.click("mememage-overlay .card [data-verify]")
            page.wait_for_selector("mememage-overlay .card .word", timeout=15000)
            page.eval_on_selector("mememage-overlay .card details", "d => d.open = true")
            page.wait_for_timeout(350)
            check("card re-clamps after growing", card_in_viewport())
            page.keyboard.press("Escape")

            # 8. the toolbar popup is the settings surface — loads (with brand header) + saves
            ext_id = sw.url.split("/")[2]
            pop = ctx.new_page()
            pop.goto("chrome-extension://%s/popup.html" % ext_id)
            pop.wait_for_selector("#sources")
            check("popup shows the MEMEMAGE brand header",
                  "MEMEMAGE" in (pop.inner_text(".brand .wordmark") or ""))
            check("popup has the barrier-side setting", pop.query_selector("#side") is not None)
            check("popup has the record-sources list + per-source timeout",
                  pop.query_selector("#sources") is not None and pop.query_selector("#timeout") is not None)
            pop.fill("#sources", "http://localhost:%d/records" % PORT)
            pop.fill("#timeout", "8")
            pop.select_option("#mode", "off")
            pop.wait_for_timeout(400)
            saved = sw.evaluate("() => chrome.storage.sync.get(['sources','timeoutMs','stickerMode'])")
            check("popup saves sources + timeout + mode to storage",
                  saved.get("sources", "").endswith("/records") and saved.get("timeoutMs") == 8000
                  and saved.get("stickerMode") == "off")
            pop.close()

            page.wait_for_timeout(500)
            check("stickers off hides all stickers", n_badges() == 0)

            # 9. mirror fallback + configurable timeout: the first source (the /slow
            #    route, which sleeps past the timeout) is skipped, the lookup falls
            #    through to the working mirror, and the image still VERIFIES — fast,
            #    proving the per-source timeout fired instead of waiting out /slow.
            #    Runs last: it sets stickerMode 'always', which the "stickers off"
            #    check above must not see.
            setcfg("{ sources: 'http://localhost:%d/slow\\nhttp://localhost:%d/records', timeoutMs: 1500, stickerMode: 'always' }" % (PORT, PORT))
            page.goto("http://localhost:%d/" % PORT)
            page.wait_for_selector("mememage-overlay .stk.on", timeout=15000)
            page.wait_for_timeout(1200)
            t0 = time.time()
            w = verify_image("verified")
            dt = time.time() - t0
            check("mirror fallback: dead first source times out, next mirror VERIFIES (%.1fs, timeout 1.5s)" % dt,
                  w == "VERIFIED" and dt < 5.0)

            ctx.close()
    finally:
        srv.terminate()

    print("\n%s — extension machine test" % ("OK" if not fails else "%d FAILED" % len(fails)))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
