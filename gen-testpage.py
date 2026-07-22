#!/usr/bin/env python3
"""Generate the extension's live test page — real barred PNGs + records, produced by
the PYTHON CORE (the authority), one per verdict state. Run from the repo root:

    python3 packaging/extension/gen-testpage.py

Then serve it and browse (see packaging/extension/README.md):

    cd packaging/extension/testpage && python3 -m http.server 8017
    # extension options -> Record source: http://localhost:8017/records
    # open http://localhost:8017

Outputs (committed, so testing needs no regeneration):
    testpage/index.html            the gallery page
    testpage/img/*.png             verified / altered / canonical / plain
    testpage/records/<id>.json     the record source the extension fetches from
"""
import json, math, os
from PIL import Image
import mememage

HERE = os.path.dirname(os.path.abspath(__file__))
TP = os.path.join(HERE, "testpage")


def art(w, h, seed):
    """Photo-ish content (smooth gradients + blobs) — friendly to the bar."""
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            r = int(120 + 90 * math.sin((x + seed * 37) / 97.0))
            g = int(110 + 80 * math.sin((y + seed * 53) / 71.0))
            b = int(130 + 70 * math.sin((x + y + seed * 11) / 131.0))
            px[x, y] = (r, g, b)
    return img


def main():
    os.makedirs(os.path.join(TP, "img"), exist_ok=True)
    os.makedirs(os.path.join(TP, "records"), exist_ok=True)
    cards = []

    def save_record(rec):
        with open(os.path.join(TP, "records", rec["identifier"] + ".json"), "w") as f:
            json.dump(rec, f, indent=2)

    # 1. VERIFIED — encode, publish the record as-is.
    r1 = mememage.encode(art(880, 560, 1), {"title": "sunrise study", "by": "testpage", "n": 1},
                         out=os.path.join(TP, "img", "verified.png"))
    save_record(r1.record)
    cards.append(("verified.png", "№1 — barred, record intact → VERIFIED"))

    # 2. ALTERED — encode, then tamper a field in the PUBLISHED record.
    r2 = mememage.encode(art(880, 560, 2), {"title": "harbor at dusk", "by": "testpage", "n": 2},
                         out=os.path.join(TP, "img", "altered.png"))
    bad = dict(r2.record)
    bad["title"] = "harbor at dawn (tampered)"
    save_record(bad)
    cards.append(("altered.png", "№2 — record tampered after minting → ALTERED"))

    # 3. UNSUPPORTED — a record claiming an app-defined hash model (the canonical
    #    chain's V1). The extension must read it as UNSUPPORTED, not tampered.
    r3 = mememage.encode(art(880, 560, 3), {"title": "meadow loop", "by": "testpage", "n": 3},
                         out=os.path.join(TP, "img", "canonical.png"))
    v1ish = dict(r3.record)
    v1ish["hash_version"] = 1
    save_record(v1ish)
    cards.append(("canonical.png", "№3 — app-defined hash model → UNSUPPORTED"))

    # 4. NO BAR — plain image.
    art(880, 560, 4).save(os.path.join(TP, "img", "plain.png"))
    cards.append(("plain.png", "№4 — no bar → nothing detected (right-click says NO BAR)"))

    # 5. MULTI-BAR — an image carrying TWO bars from different parties. Mint an inner
    #    piece (its own bottom bar), paste it into a taller canvas so that bar lands
    #    mid-image, then stamp the composite (a second bar at the bottom). extract_bars
    #    finds both, at different rows — the extension should marker each one.
    inner = mememage.encode(art(760, 300, 5), {"title": "inner piece", "by": "party-A", "n": 5})
    comp = Image.new("RGB", (760, 620))
    comp.paste(art(760, 620, 6), (0, 0))
    comp.paste(inner.image, (0, 40))                      # inner's bar now sits ~row 340
    outer = mememage.encode(comp, {"title": "outer composite", "by": "party-B", "n": 6},
                            out=os.path.join(TP, "img", "multibar.png"))
    save_record(inner.record)
    save_record(outer.record)
    cards.append(("multibar.png", "№5 — TWO bars (inner + composite) → a marker per bar"))

    # 6. RESOLUTION MISMATCH — the SW's fetch() decodes a TALLER version than the <img>
    #    displays (responsive/CDN resize keyed on request headers). testserver.py serves
    #    mismatch_tall.png to fetch() and mismatch_short.png to the <img>. The marker
    #    must still land on the rendered image's bar (fraction mapping, not naturalHeight).
    #    Different WIDTH and height: the display is the true 1024x1024 (barrier ~24px at
    #    its native res); the SW fetches a 768x768 downscale. Both decode to the same
    #    identifier. The marker's barrier must be 12px from the DISPLAY's edge (scaled by
    #    naturalWidth), and the bar's bottom/edge from the SW fraction.
    mm = mememage.encode(art(1024, 1024, 7), {"title": "resolution mismatch", "by": "testpage", "n": 7},
                         out=os.path.join(TP, "img", "mismatch_disp.png"))
    save_record(mm.record)
    Image.open(os.path.join(TP, "img", "mismatch_disp.png")).resize((768, 768), Image.LANCZOS) \
        .save(os.path.join(TP, "img", "mismatch_sw.png"))
    # A static mismatch.png so PLAIN http.server shows a marker (no real mismatch — both
    # get 1024). testserver.py INTERCEPTS this path and serves the SW the 768 copy, which
    # is what makes it a true resolution-mismatch test. Run testserver.py for that.
    Image.open(os.path.join(TP, "img", "mismatch_disp.png")).save(os.path.join(TP, "img", "mismatch.png"))

    # 7. OFFSET BAR — a barred image pasted into a LARGER canvas, so the bar sits inside
    #    the canvas, not at its edge (enlarged canvas / paste-in). The marker must land
    #    on the bar's ACTUAL barrier (its detected left/right), not the canvas edge.
    ob = mememage.encode(art(500, 300, 8), {"title": "offset bar", "by": "testpage", "n": 8})
    canvas = Image.new("RGB", (900, 520))
    canvas.paste(art(900, 520, 9), (0, 0))
    canvas.paste(ob.image, (230, 150))                   # bar now spans x[230,730] @ row ~449
    canvas.save(os.path.join(TP, "img", "offset.png"))
    save_record(ob.record)

    # 8. VERY WIDE — for the pillarbox + object-position cases below (a wide image
    #    left-aligned in an even-wider box threw the marker into the right margin).
    wide = mememage.encode(art(1800, 420, 11), {"title": "very wide", "by": "testpage", "n": 11},
                           out=os.path.join(TP, "img", "wide.png"))
    save_record(wide.record)

    # 9. TOP-OF-FRAME BAR — a readable bar placed HIGH in the frame (crop the bar strip
    #    and paste it near the top of a taller canvas). Sitting the marker above it would
    #    clip off the top, so placement must flip: sit BELOW the bar and slide DOWN,
    #    keeping the marker inside the canvas.
    tb = mememage.encode(art(640, 360, 3), {"title": "top bar", "by": "testpage", "n": 3})
    strip = tb.image.crop((0, 360 - 18, 640, 360))       # bar + a few reference rows above it
    tbc = Image.new("RGB", (640, 600))
    tbc.paste(art(640, 600, 4), (0, 0))
    tbc.paste(strip, (0, 4))                             # bar ends ~row 21 of a 600-tall frame
    tbc.save(os.path.join(TP, "img", "topbar.png"))
    save_record(tb.record)

    figs = "\n".join(
        '    <figure><img src="img/%s" alt=""><figcaption>%s</figcaption></figure>' % (f, c)
        for f, c in cards)
    html = r"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Mememage extension — test page</title>
<style>
  body{font-family:ui-monospace,Menlo,monospace;background:#0d0d10;color:#c8c8cc;max-width:1040px;
       margin:0 auto;padding:2rem 1.2rem 6rem;line-height:1.5}
  h1{font-weight:500;font-size:1.4rem;margin-bottom:.3rem}
  h2{font-weight:600;font-size:.95rem;margin:2.4rem 0 .3rem;color:#e0e0e6;border-top:1px solid #23232a;padding-top:1.4rem}
  p{color:#8a8a92;font-size:.78rem;max-width:46rem;margin:.3rem 0}
  code{background:#1c1c20;padding:.1em .4em;border-radius:4px}
  .lead{background:#141418;border:1px solid #23232a;border-radius:10px;padding:.9rem 1.1rem;margin:1rem 0}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.1rem;margin-top:1rem}
  figure{margin:0} img{width:100%;height:auto;border-radius:8px;display:block}
  figcaption{font-size:.68rem;color:#8a8a92;margin-top:.35rem}
  .box{background:#111;border-radius:8px}
  button{font-family:inherit;font-size:.72rem;background:#1a1a1e;color:#d0d0d6;border:1px solid #33333c;
         border-radius:6px;padding:.4em 1em;cursor:pointer;margin:.5rem .4rem 0 0}
  button:hover{border-color:#555;color:#fff}
  .want{font-size:.66rem;color:#7bc4a0;margin-top:.3rem}
  .gap{font-size:.66rem;color:#d4b87b;margin-top:.3rem}
  .row{display:flex;gap:1.4rem;flex-wrap:wrap;align-items:flex-start}
  .row>div{flex:0 0 auto}
</style></head><body>
  <h1>Mememage extension — test page</h1>
  <div class="lead"><p style="color:#c8c8cc">Every scenario in one place, for eyeballing. Load the extension
  unpacked, open its popup, set <b>Record source</b> to <code>http://localhost:8017/records</code> and
  <b>Markers: always</b>. Green notes are what to expect; amber notes are known gaps.</p></div>

  <h2>1 · Core verdicts</h2>
  <p class="want">want: a marker per bar; click to verify (VERIFIED / ALTERED / UNSUPPORTED). №4 no bar. №5 two bars.</p>
  <div class="grid">{{FIGS}}</div>

  <h2>2 · Letterbox (object-fit: contain)</h2>
  <p class="want">want: marker on the rendered image's barrier, inset from the black element edge.</p>
  <div class="box" style="width:640px;max-width:100%;height:300px">
    <img id="letterbox" src="img/verified.png" style="width:100%;height:100%;object-fit:contain" alt=""></div>

  <h2>3 · Lightbox geometries (pillarbox / letterbox / big-margin multibar)</h2>
  <p class="want">want: each image's marker(s) on its own rendered barrier.</p>
  <div class="lb box" style="width:900px;max-width:100%;height:420px">
    <img class="lbimg" src="img/multibar.png" style="width:100%;height:100%;object-fit:contain" alt=""></div>
  <div class="lb box" style="width:420px;max-width:100%;height:560px;margin-top:1rem">
    <img class="lbimg" src="img/multibar.png" style="width:100%;height:100%;object-fit:contain" alt=""></div>
  <div class="lb box" style="width:760px;max-width:100%;height:680px;margin-top:1rem">
    <img class="lbimg" src="img/verified.png" style="width:100%;height:100%;object-fit:contain" alt=""></div>

  <h2>4 · object-position (wide image pushed to one side)</h2>
  <p class="want">want: the marker follows the image, never sits in the empty margin.</p>
  <div class="lbpos box" style="width:1100px;max-width:100%;height:150px">
    <img class="lbposimg" src="img/wide.png" style="width:100%;height:100%;object-fit:contain;object-position:left" alt=""></div>
  <div class="lbpos box" style="width:1100px;max-width:100%;height:150px;margin-top:1rem">
    <img class="lbposimg" src="img/wide.png" style="width:100%;height:100%;object-fit:contain;object-position:right" alt=""></div>

  <h2>5 · Resolution mismatch (SW decodes a different size than displayed)</h2>
  <p class="want">want: marker on the barrier both axes — the server hands the SW a 768px copy, the page a 1024px one.</p>
  <img id="mismatch" src="img/mismatch.png" style="width:400px;max-width:100%;height:auto" alt="">

  <h2>6 · Offset bar (pasted into a larger canvas)</h2>
  <p class="want">want: marker on the bar's actual barrier inside the canvas (x 230..730 of 900), not the corner.</p>
  <img id="offset" src="img/offset.png" style="width:600px;max-width:100%;height:auto" alt="">

  <h2>7 · Top-of-frame bar (slide flips DOWN)</h2>
  <p class="want">want: bar is high in the frame, so the marker sits BELOW it and slides down — never clips off the top.</p>
  <img id="topbar" src="img/topbar.png" style="width:400px;max-width:100%;height:auto" alt="">

  <h2>8 · Dynamic &lt;img&gt; (the common real-web patterns)</h2>
  <p>Press the buttons and watch. A stale card/marker should also update on a swap.</p>
  <div class="row">
    <div>
      <img id="lazy" style="width:300px;height:190px;background:#141418;border-radius:8px" alt="">
      <button onclick="mmLazy()">lazy-load: set src</button>
      <div class="want">want: marker appears when the real src arrives.</div>
    </div>
    <div>
      <img id="carousel" src="img/plain.png" style="width:300px;display:block" alt="">
      <button onclick="mmCarousel()">carousel: swap src</button>
      <div class="want">want: none on plain; appears after swapping to a barred image; and back.</div>
    </div>
    <div id="spa-slot">
      <button onclick="mmSpa()">SPA: add image</button>
      <div class="want">want: a markered image appears below.</div>
    </div>
  </div>
  <div style="margin-top:1rem">
    <img id="srcset" srcset="img/multibar.png" style="width:300px;display:block" alt="">
    <div class="want">srcset: two markers (multibar via srcset).</div>
  </div>

  <h2>9 · Non-&lt;img&gt; surfaces</h2>
  <p class="want">want: both markered too — a &lt;canvas&gt; is re-encoded for the SW; a background-image is fetched by its URL.</p>
  <div class="row">
    <div>
      <div id="bgdiv" style="width:300px;height:191px;background:url(img/verified.png) center/cover;border-radius:8px"></div>
      <div class="want">CSS background-image (verified) — one marker</div>
    </div>
    <div>
      <canvas id="cv" style="width:300px;height:auto;display:block;border-radius:8px"></canvas>
      <div class="want">&lt;canvas&gt; (multibar drawn 1:1) — two markers</div>
    </div>
  </div>

<script>
  function mmLazy(){ document.getElementById('lazy').src = 'img/altered.png'; }
  function mmCarousel(){ var i=document.getElementById('carousel');
    i.src = i.src.indexOf('plain')>=0 ? 'img/canonical.png' : 'img/plain.png'; }
  function mmSpa(){ var i=document.createElement('img'); i.src='img/verified.png';
    i.style.cssText='width:300px;display:block;margin-top:8px'; document.getElementById('spa-slot').appendChild(i); }
  (function(){ var cv=document.getElementById('cv'); var im=new Image();
    im.onload=function(){ cv.width=im.naturalWidth; cv.height=im.naturalHeight; cv.getContext('2d').drawImage(im,0,0); };
    im.src='img/multibar.png'; })();
</script>
</body></html>
"""
    with open(os.path.join(TP, "index.html"), "w") as f:
        f.write(html.replace("{{FIGS}}", figs))

    print("testpage written:", ", ".join(f for f, _ in cards))
    print("records:", ", ".join(sorted(os.listdir(os.path.join(TP, "records")))))


if __name__ == "__main__":
    main()
