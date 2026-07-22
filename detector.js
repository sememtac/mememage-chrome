// Mememage extension — DETECTOR (content-script, loads before content.js).
//
// The image-detection engine: watch the page, find every image that carries a
// Mememage bar, report where each bar sits on screen, and track it through the
// page's life. It emits detections; content.js (the UI) subscribes and draws.
//
// This is a CONTENT SCRIPT, not a module (MV3 content scripts cannot `import`),
// so it is a plain script that exposes ONE global — window.MememageDetector —
// and content.js consumes it. (The SW is a module and imports the SDK; the
// content side reaches decode only through the SW message transport.)
//
// Scope: IMAGE ONLY. The detector owns no network beyond decoding this image's
// own pixels (via the SW). Record resolution (sources, timeout, verify) is the
// resolver's job and lives in the UI/SW, never here. See
// docs/plans/extension-extensibility.md.
(function () {
  "use strict";
  if (window.MememageDetector) return;              // idempotent across re-injections

  var MIN_W = 200, MIN_H = 48;                       // passive gate (skip chatter)
  var BARRIER_MID = 12;                              // barrier middle, native px from the image edge
  var DEBUG = false;
  try { DEBUG = !!localStorage.getItem("mememage-debug"); } catch (e) {}

  // ---- event emitter: detected / removed / reposition -----------------------
  // Two channels. (1) In-world: `on(...)` — our UI (same isolated world) subscribes.
  // (2) Public DOM events — see below.
  var listeners = { detected: [], removed: [], reposition: [] };
  function on(ev, cb) { (listeners[ev] || (listeners[ev] = [])).push(cb); }
  function emit(ev, arg) {
    var L = listeners[ev];
    if (L) for (var i = 0; i < L.length; i++) { try { L[i](arg); } catch (e) {} }
  }

  // ---- public DOM events (the in-page API) ----------------------------------
  // `mememage:detected` / `mememage:removed` are dispatched on the carrier element
  // (bubbling to document) so ANY listener on the page can react — a page script, a
  // userscript, or another extension's content script. See API.md.
  //   • detail is PLAIN DATA (JSON-cloneable). Functions cannot cross the content-script
  //     / page world boundary, so no rect()/verify() ride along; a consumer recomputes
  //     geometry from the data, or imports the detector library (Phase 4). The identifier
  //     and hash are untrusted data, never instructions.
  //   • `mememage:detected` is cancelable: a listener that calls preventDefault()
  //     suppresses our default marker for that detection.
  function publicDetail(det) {
    return {
      bars: det.bars.map(function (b) {
        return { identifier: b.identifier, contentHash: b.contentHash,
                 bottomRow: b.bottomRow, left: b.left, right: b.right };
      }),
      scanWidth: det.scanWidth, scanHeight: det.scanHeight,
    };
  }
  function fireDom(name, el, detail, cancelable) {
    try {
      return el.dispatchEvent(new CustomEvent(name, {
        detail: detail || {}, bubbles: true, cancelable: !!cancelable }));  // false = preventDefault called
    } catch (e) { return true; }
  }

  // ---- decode transport: message the SW (the only SDK consumer) -------------
  // scan / decode only. verify / fetchrec are the resolver's, owned by the UI.
  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          void chrome.runtime.lastError;             // SW asleep/reloading — treat as no answer
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  // ---- geometry -------------------------------------------------------------
  // Position fraction [0..1] from one object-position token (against the leftover
  // space = box - image). "50%"→center, "0%"→start, "100%"→end; px offsets map to a
  // fraction of the leftover; keywords compute to % so they're covered. Default center.
  function posFraction(tok, box, img) {
    if (tok == null) return 0.5;
    if (tok.charAt(tok.length - 1) === "%") return parseFloat(tok) / 100;
    if (tok.slice(-2) === "px") { var sp = box - img; return sp !== 0 ? parseFloat(tok) / sp : 0.5; }
    return 0.5;
  }

  // The RENDERED image rectangle inside the element box. When the box's aspect differs
  // from the image's (object-fit:contain, background-size, a resolution mismatch), the
  // real image is letterboxed inside the element — the bar/barriers sit at the IMAGE's
  // edges, not the element's — and fit/position decide where.
  function renderedRect(r, nw, nh, fit, pos) {
    if (!nw || !nh || fit === "fill") return { left: r.left, top: r.top, width: r.width, height: r.height };
    var nar = nw / nh, bar = r.width / r.height, rw, rh;
    if (fit === "cover") {
      if (bar > nar) { rw = r.width; rh = rw / nar; } else { rh = r.height; rw = rh * nar; }
    } else if (fit === "none") {
      rw = nw; rh = nh;
    } else {  // contain / scale-down
      if (bar > nar) { rh = r.height; rw = rh * nar; } else { rw = r.width; rh = rw / nar; }
      if (fit === "scale-down") { rw = Math.min(rw, nw); rh = Math.min(rh, nh); }
    }
    var p = (pos || "50% 50%").split(/\s+/);
    var px = posFraction(p[0], r.width, rw), py = posFraction(p[1], r.height, rh);
    return { left: r.left + (r.width - rw) * px, top: r.top + (r.height - rh) * py, width: rw, height: rh };
  }

  // Intrinsic size + fit + position for ANY markerable element. <img>/<canvas> are
  // replaced elements: object-fit + object-position, intrinsic from naturalWidth/width.
  // A background-image host: background-size→fit, background-position→pos, intrinsic
  // size = the DECODED image's (sw/sh — a background has no naturalWidth).
  function renderInfo(el, sw, sh) {
    var cs; try { cs = getComputedStyle(el); } catch (e) { cs = {}; }
    if (el.tagName === "IMG" || el.tagName === "CANVAS") {
      return { nw: el.naturalWidth || el.width || sw, nh: el.naturalHeight || el.height || sh,
               fit: cs.objectFit || "fill", pos: cs.objectPosition || "50% 50%" };
    }
    var bs = cs.backgroundSize || "auto";
    var fit = bs === "cover" ? "cover" : bs === "contain" ? "contain" : "none";
    return { nw: sw, nh: sh, fit: fit, pos: cs.backgroundPosition || "50% 50%" };
  }

  // place(element, bar, side) -> { onScreen, cx, top, down }
  // The live geometry a consumer needs to put a small UI element on the bar's color
  // barrier: cx = the barrier middle on screen, top = where a 16px marker sits (just
  // above the bar, or just below with `down` when above would clip the image top). This
  // is the placement math that inherits every geometry fix — letterbox, object-position,
  // resolution mismatch, offset/pasted bars. `side` (image-only UI preference) picks the
  // barrier; the detector does not own it, the consumer passes it in.
  function place(el, bar, side) {
    var r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 24 || r.bottom < 0 || r.top > innerHeight ||
        r.right < 0 || r.left > innerWidth) {
      return { onScreen: false };
    }
    // Map bar coords by FRACTION of the SW-decoded image (where bottomRow & the barriers
    // live), so a displayed image at a different resolution still aligns.
    var sh = bar._sh || 1, sw = bar._sw || 1;
    var info = renderInfo(el, sw, sh);
    var rr = renderedRect(r, info.nw, info.nh, info.fit, info.pos);
    var barRow = (bar.bottomRow != null ? bar.bottomRow : sh - 1);
    var barTopFrac = Math.max(0, barRow - 2) / sh;       // bar's top edge, as a fraction of height
    var barBotFrac = Math.min(sh, barRow + 1) / sh;      // just below the bar's bottom row
    // Barrier middle. Two independently-scaled parts:
    //   (1) the bar's EDGE — a physical point; its fraction of the width is invariant
    //       under resize, so take it from the SW-decoded bbox: left/sw or right/sw.
    //   (2) step the barrier half-width (~12px at NATIVE resolution) inward. Scale that
    //       by naturalWidth, NOT sw — a resolution mismatch (768 vs 1024) would drift it.
    var barLeft = (bar.left != null ? bar.left : 0);
    var barRight = (bar.right != null ? bar.right : sw - 1);
    var edgeFrac = (side === "left") ? (barLeft / sw) : (barRight / sw);
    var offsetFrac = BARRIER_MID / (info.nw || sw);
    var barrierFrac = (side === "left") ? (edgeFrac + offsetFrac) : (edgeFrac - offsetFrac);
    var cx = rr.left + barrierFrac * rr.width;
    // Vertical: sit just ABOVE the bar (slide up out of it) unless that clips the image
    // top; then flip BELOW (slide down), keeping the marker inside the canvas.
    var aboveTop = rr.top + barTopFrac * rr.height - 18;
    var down = aboveTop < rr.top;
    var top = down ? (rr.top + barBotFrac * rr.height + 2) : aboveTop;
    if (DEBUG) {
      var key = Math.round(cx - 8) + "," + Math.round(top);
      if (el._mmDbgKey !== key) {
        el._mmDbgKey = key;
        var srcLabel = (el.currentSrc || el.src || el.tagName || "?");
        console.log("[mememage]", srcLabel.split("/").pop().slice(-44),
          "| elem", Math.round(r.width) + "x" + Math.round(r.height),
          "| nat", info.nw + "x" + info.nh, "| swDecoded", sw + "x" + sh, "| fit", info.fit,
          "| rr", Math.round(rr.width) + "x" + Math.round(rr.height) + "@" + Math.round(rr.left) + "," + Math.round(rr.top),
          "| bar bbox L" + bar.left + " R" + bar.right + " row" + bar.bottomRow,
          "| marker@", Math.round(cx - 8) + "," + Math.round(top));
      }
    }
    return { onScreen: true, cx: cx, top: top, down: down };
  }

  // ---- eligibility + pixel access -------------------------------------------
  function eligible(img) {
    var u = img.currentSrc || img.src || "";
    if (!u) return false;
    // blob: is page-scoped (the SW can't fetch it) but the content script CAN — scanImg
    // re-encodes it to a data: URL below, so blob: images are eligible.
    return img.complete && img.naturalWidth >= MIN_W && img.naturalHeight >= MIN_H;
  }
  // A blob: URL is page-scoped: the SW (extension origin) cannot fetch it, but the content
  // script shares the page origin and CAN. Re-encode the loaded <img> to a data: URL the
  // SW can decode (the same move as the canvas path). Returns null if the draw fails — a
  // cross-origin taint, which never happens for a blob: (same-origin bytes), only a guard.
  function imgToDataUrl(img) {
    try {
      var c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      return c.toDataURL("image/png");
    } catch (e) { return null; }
  }

  // ---- detection lifecycle --------------------------------------------------
  var detectedEls = new Set();                       // elements with a live detection
  function toDetection(el, scan) {
    var bars = (scan.bars || []).map(function (b) { b._sw = scan.width; b._sh = scan.height; return b; });
    return { element: el, bars: bars, scanWidth: scan.width, scanHeight: scan.height };
  }
  function detect(el, scan) {                         // emit a NEW detection (dedup on element)
    var det = toDetection(el, scan);
    if (detectedEls.has(el)) return det;             // already detected: no re-emit, return a view
    detectedEls.add(el);
    resizeObs.observe(el);
    var allowed = fireDom("mememage:detected", el, publicDetail(det), true);
    if (allowed) emit("detected", det);              // our UI draws only if a listener didn't suppress it
    return det;
  }
  function undetect(el) {                             // src changed / element gone
    if (!detectedEls.has(el)) return;
    detectedEls.delete(el);
    resizeObs.unobserve(el);
    fireDom("mememage:removed", el, {}, false);
    emit("removed", { element: el });
  }

  // ---- scan orchestration ---------------------------------------------------
  function nearViewport(img) {
    var r = img.getBoundingClientRect();
    return r.bottom > -200 && r.top < innerHeight + 200 && r.right > -200 && r.left < innerWidth + 200;
  }
  function scanImg(img) {
    if (!eligible(img)) return;
    var url = img.currentSrc || img.src;
    if (img._mmScannedSrc === url) return;           // this exact src already scanned
    img._mmScannedSrc = url;
    var scanUrl = url;
    if (url.slice(0, 5) === "blob:") {               // page-scoped: convert here, the SW can't fetch it
      scanUrl = imgToDataUrl(img);
      if (!scanUrl) return;
    }
    send({ t: "scan", url: scanUrl }).then(function (r) {
      if ((img.currentSrc || img.src) !== url) return;  // src changed while we awaited
      if (r && r.found) detect(img, r);
    });
  }
  function onImgLoad(img) {
    var url = img.currentSrc || img.src;
    if (img._mmScannedSrc && img._mmScannedSrc !== url) { undetect(img); img._mmScannedSrc = null; }
    if (nearViewport(img)) scanImg(img);             // load off-screen -> the observer scans on scroll-in
  }
  // <canvas>: re-encode to a PNG data URL (throws if cross-origin-tainted) and let the SW
  // decode it — with a backoff, since a canvas is often drawn just AFTER we observe it.
  var CANVAS_RETRIES = [300, 700, 1500, 3000];
  function scanCanvas(cv) {
    if (cv._mmStarted) return;                       // one chain per canvas
    cv._mmStarted = true;
    var attempt = 0;
    function next() { if (attempt < CANVAS_RETRIES.length) setTimeout(tryOnce, CANVAS_RETRIES[attempt++]); }
    function tryOnce() {
      if (cv._mmDone) return;
      if (cv.width < MIN_W || cv.height < MIN_H) { next(); return; }   // not drawn / too small yet
      var url;
      try { url = cv.toDataURL("image/png"); } catch (e) { cv._mmDone = true; return; }  // cross-origin taint
      send({ t: "scan", url: url }).then(function (r) {
        if (cv._mmDone) return;
        if (r && r.found) { cv._mmDone = true; detect(cv, r); }
        else {
          if (DEBUG) console.log("[mememage] canvas scan no-bar", cv.width + "x" + cv.height, r && r.error ? "err:" + r.error : "");
          next();
        }
      });
    }
    tryOnce();
  }
  // CSS background-image: hand the SW the background URL (fetched fresh, cross-origin is fine).
  function scanBg(el) {
    if (el._mmDone) return;
    el._mmDone = true;
    var bi; try { bi = getComputedStyle(el).backgroundImage; } catch (e) { return; }
    var m = /url\(["']?([^"')]+)["']?\)/.exec(bi || "");
    if (!m) return;
    var url; try { url = new URL(m[1], location.href).href; } catch (e) { return; }
    if (url.slice(0, 5) === "blob:") return;
    send({ t: "scan", url: url }).then(function (r) { if (r && r.found) detect(el, r); });
  }

  // ---- discovery (viewport-lazy) --------------------------------------------
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var el = en.target;
      if (el.tagName === "IMG") scanImg(el);
      else if (el.tagName === "CANVAS") scanCanvas(el);
      else scanBg(el);
    });
  }, { rootMargin: "200px" });
  function watchImg(img) { io.observe(img); img.addEventListener("load", function () { onImgLoad(img); }); }
  function checkBg(el) {                              // observe only if it carries a background-image URL
    if (el._mmBgChecked) return;
    el._mmBgChecked = true;
    var bi; try { bi = getComputedStyle(el).backgroundImage; } catch (e) { return; }
    if (bi && bi.indexOf("url(") >= 0) io.observe(el);
  }
  // Discover all three surfaces in a subtree. Background-image has no cheap selector, so
  // getComputedStyle each element ONCE (marked _mmBgChecked) — amortized, capped so a huge
  // page can't stall (bg beyond the cap is simply not scanned).
  function discover(node) {
    if (node.tagName === "IMG") watchImg(node);
    else if (node.tagName === "CANVAS") io.observe(node);
    else checkBg(node);
    if (!node.querySelectorAll) return;
    node.querySelectorAll("img").forEach(watchImg);
    node.querySelectorAll("canvas").forEach(function (c) { io.observe(c); });
    var all = node.querySelectorAll("*"), n = Math.min(all.length, 6000);
    for (var i = 0; i < n; i++) checkBg(all[i]);
  }

  // ---- reposition loop (keep geometry fresh) --------------------------------
  var rafPending = false;
  function fireReposition() { emit("reposition"); }
  function onViewportChange() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; fireReposition(); });
  }
  // ResizeObserver — fires per-frame WHILE a detected image's box resizes (size-up /
  // expand), silent otherwise. rAF "follow" — covers transform/position transitions (no
  // box resize, so ResizeObserver won't catch them), bounded so a runaway can't spin rAF.
  var resizeObs = new ResizeObserver(function () { fireReposition(); });
  var followRaf = 0, followUntil = 0;
  function followPump() {
    fireReposition();
    if (performance.now() < followUntil) followRaf = requestAnimationFrame(followPump);
    else followRaf = 0;
  }
  function follow(ms) {
    followUntil = Math.max(followUntil, performance.now() + ms);
    if (!followRaf) followRaf = requestAnimationFrame(followPump);
  }
  function touchesDetected(target) {
    if (!(target instanceof Element) || !detectedEls.size) return false;
    var hit = false;
    detectedEls.forEach(function (el) { if (!hit && (target === el || target.contains(el))) hit = true; });
    return hit;
  }
  function onAnim(e) { if (touchesDetected(e.target)) follow(800); }

  // ---- deep scan (right-click entry point) ----------------------------------
  // Decode a specific URL and, if bars are found, emit a detection so markers appear.
  // Returns a shape the UI uses to open the card: {found, detection} | {noBar} | {error} | {blob}.
  function detectAt(url, el) {
    var decodeUrl = url;
    if (url.slice(0, 5) === "blob:") {
      decodeUrl = el ? imgToDataUrl(el) : null;
      if (!decodeUrl) return Promise.resolve({ blob: true });
    }
    return send({ t: "decode", url: decodeUrl }).then(function (r) {
      if (r && r.found && r.bars && r.bars.length) {
        if (el) el._mmScannedSrc = el.currentSrc || el.src;
        return { found: true, detection: el ? detect(el, r) : toDetection(el, r) };
      }
      if (r && r.error) return { error: r.error };
      return { noBar: true };
    });
  }

  // ---- start ----------------------------------------------------------------
  var started = false;
  function start() {                                 // the UI calls this AFTER it subscribes
    if (started) return; started = true;
    addEventListener("scroll", onViewportChange, { passive: true, capture: true });
    addEventListener("resize", onViewportChange, { passive: true });
    setInterval(fireReposition, 1200);               // layout drift the events don't cover
    document.addEventListener("transitionrun", onAnim, true);
    document.addEventListener("animationstart", onAnim, true);
    discover(document.documentElement);
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes && m.addedNodes.forEach(function (n) { if (n.nodeType === 1) discover(n); });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  window.MememageDetector = {
    on: on,               // on("detected"|"removed"|"reposition", cb)
    place: place,         // place(element, bar, side) -> { onScreen, cx, top, down }
    detectAt: detectAt,   // detectAt(url, element) -> Promise (right-click deep scan)
    start: start,
    MIN_W: MIN_W, MIN_H: MIN_H,
  };
})();
