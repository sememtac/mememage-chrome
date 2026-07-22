// Mememage extension — UI (content script, loads after detector.js).
//
// A CONSUMER of window.MememageDetector. The detector finds bars and reports where
// they are; this file draws the markers and the command card. It owns the overlay,
// hover, the active-marker state, and the card (verify / fetch record / options).
// No bar logic and no detection here — see detector.js. Verify and fetch record are
// the RESOLVER's job (they message the SW), not the detector's; the UI calls them.
//
// The card is the UX interface: click a marker -> a minimal card with the identifier
// + hash and all commands right there. Explanations live behind collapsibles. Click
// anywhere else to dismiss (hover never dismisses); Escape too. The card is
// window-aware: it re-clamps into the viewport whenever it grows or the window resizes.
(function () {
  "use strict";
  if (window.__mememageUI) return;                   // idempotent across SPA re-injections
  window.__mememageUI = true;
  var D = window.MememageDetector;
  if (!D) return;                                    // detector.js must load first

  // User-facing copy in Simplified Technical English: short sentences, active voice,
  // consistent terms (marker / bar / record / source / image). See feedback memory.
  var VERDICTS = {
    verified:    { word: "VERIFIED",    color: "#7bc4a0",
      why: "The record matches this image by content hash. The data is intact, and it matches these pixels." },
    altered:     { word: "ALTERED",     color: "#e06060",
      why: "The record does not match this image. The data changed, or this is the wrong record for these pixels." },
    unsupported: { word: "IDENTIFIED", color: "#8ab0c8",
      why: "The extension read the bar and found the record. The identity is confirmed. This record uses a hash model the extension does not implement. The extension cannot check this record's integrity here. The extension checks the open model. This is not tampering." },
    norecord:    { word: "NO RECORD",   color: "#9a8fb8",
      why: "The source has no record for this identifier. The bar is valid. The record is not at the source." },
    error:       { word: "NO CHECK",    color: "#808088", why: "The extension could not complete the check." },
  };
  var WHAT_IS_THIS =
    "This image has a Mememage bar. The bar holds an identifier and a content hash " +
    "in the pixels. Click verify to fetch the record from your sources and check its hash " +
    "against the bar. All checks run in your browser. Click fetch record to get the record " +
    "and open it in a new tab.";
  var WHY_NO_BAR =
    "Most platforms re-encode images, for example to WebP or a smaller JPEG. This " +
    "removes the bar. This is normal for a re-shared image. An image that never had a bar " +
    "looks the same here.";

  // ---- overlay host (shadow DOM on documentElement — page CSS can't touch it) ----
  var host = document.createElement("mememage-overlay");
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;";
  var root = host.attachShadow({ mode: "open" });
  var style = document.createElement("style");
  style.textContent = [
    ":host{all:initial}",
    // Polaroid eject: the icon SLIDES UP out of the barrier (translateY, not scale),
    // fading in with a slight overshoot. Hover = a small uniform grow, no vertical nudge.
    ".stk{position:fixed;width:16px;height:16px;cursor:pointer;pointer-events:auto;",
    "  box-shadow:0 2px 7px rgba(0,0,0,.55);opacity:0;transform:translateY(14px) scale(1);",
    "  transition:opacity .2s ease-out,transform .38s cubic-bezier(.34,1.55,.4,1)}",
    // .down = the marker sits BELOW a top-of-frame bar and slides DOWN out of it. Order
    // matters: .stk.on (resting) is defined AFTER .stk.down so it wins for the settled state.
    ".stk.down{transform:translateY(-14px) scale(1)}",
    ".stk.on{opacity:.95;transform:translateY(0) scale(1)} .stk.on:hover{opacity:1;transform:translateY(0) scale(1.1)}",
    ".card{position:fixed;width:276px;max-width:92vw;background:#111114;border:1px solid rgba(180,180,190,.2);",
    "  border-radius:9px;box-shadow:0 14px 40px rgba(0,0,0,.7);pointer-events:auto;overflow:hidden;",
    "  font-family:ui-monospace,Menlo,Consolas,monospace;color:#d0d0d4;font-size:12px;line-height:1.45}",
    ".card .strip{height:1px;display:flex}.card .strip i{flex:1}",
    ".card .strip i:nth-child(1){background:#dc50dc}.card .strip i:nth-child(2){background:#dcc83c}.card .strip i:nth-child(3){background:#3cc8dc}",
    ".card .body{padding:8px 11px 9px}",
    ".idl{font-size:11.5px;word-break:break-all;user-select:text;cursor:text}",
    ".idl b{color:#e4e4e8;font-weight:600}",
    ".hsh{color:#8a8a92;font-size:10.5px}",
    ".acts{display:flex;gap:5px;margin-top:8px;flex-wrap:wrap}",
    ".acts button{font-family:inherit;font-size:10.5px;color:#c0c0c6;background:#1a1a1e;",
    "  border:1px solid rgba(180,180,190,.2);border-radius:6px;padding:3px 9px;cursor:pointer}",
    ".acts button:hover{color:#fff;border-color:#666;background:#222227}",
    ".out{margin-top:7px;font-size:11px;color:#8a8a92}",
    ".out:empty{display:none}",
    ".vline{display:flex;align-items:center;gap:7px}",
    ".dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}",
    ".word{font-weight:700;letter-spacing:.05em;font-size:12px}",
    ".out a{color:#3cc8dc;text-decoration:none}.out a:hover{text-decoration:underline}",
    "details{margin-top:7px;font-size:10.5px;color:#8a8a92}",
    "details summary{cursor:pointer;color:#68686f;list-style:none;outline:none}",
    "details summary::before{content:'\\25B8  '}details[open] summary::before{content:'\\25BE  '}",
    "details summary:hover{color:#a0a0a8}",
    "details div{margin-top:5px;line-height:1.55}",
    ".plain{font-size:11.5px;color:#a0a0a8}",
    ".steps{font-size:11px;color:#68686f}",
  ].join("\n");
  root.appendChild(style);
  var ICON_URL = chrome.runtime.getURL("icons/icon32.png");
  function mountHost() {
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  }
  mountHost();

  // ---- settings (UI: marker mode + anchor side) ----
  var markerMode = "hover";             // hover (default) | always | off
  var markerSide = "right";             // color barrier to anchor on: left (M/Y/C) | right (C/Y/M)
  function normMode(cfg) {
    if (cfg.markerMode === "always" || cfg.markerMode === "off" || cfg.markerMode === "hover")
      return cfg.markerMode;
    if (cfg.markers === false) return "off";        // legacy boolean migration
    return "hover";
  }
  try {
    chrome.storage.sync.get({ markerMode: null, markers: null, side: "right" }, function (cfg) {
      markerMode = normMode(cfg);
      markerSide = cfg.side === "left" ? "left" : "right";
      refreshAll();
    });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "sync") return;
      if (ch.markerMode) markerMode = normMode({ markerMode: ch.markerMode.newValue });
      if (ch.markers) markerMode = normMode({ markers: ch.markers.newValue });
      if (ch.side) markerSide = ch.side.newValue === "left" ? "left" : "right";
      if (ch.markerMode || ch.markers || ch.side) refreshAll();
    });
  } catch (e) { /* storage unavailable (rare) — defaults hold */ }

  // ---- resolver transport (verify / fetch record / options) ----
  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  // ---- markers (subscribe to the detector) ----
  // One image can carry SEVERAL bars — each gets its own badge, on its own barrier.
  var tracked = new Map();   // element -> { badges: [{el, bar}], hover, graceTimer }
  var activeBadge = null;    // the badge whose card is open — stays visible past mouseleave

  function positionOne(el, bar, badgeEl, visibleWanted) {
    var p = D.place(el, bar, markerSide);
    if (!p.onScreen || (!visibleWanted && badgeEl !== activeBadge)) {
      badgeEl.classList.remove("on");
      badgeEl.style.pointerEvents = "none";
      return;
    }
    badgeEl.style.pointerEvents = "auto";
    badgeEl.style.left = (p.cx - 8) + "px";
    badgeEl.style.top = p.top + "px";
    badgeEl.classList.toggle("down", p.down);
    badgeEl.classList.add("on");
  }
  function positionBadges(el, t) {
    var visible = el.isConnected && (markerMode === "always" || (markerMode === "hover" && t.hover));
    for (var i = 0; i < t.badges.length; i++) positionOne(el, t.badges[i].bar, t.badges[i].el, visible);
  }
  function refreshAll() {
    mountHost();
    tracked.forEach(function (t, el) { positionBadges(el, t); });
  }

  function setHover(el, on) {
    var t = tracked.get(el);
    if (!t) return;
    clearTimeout(t.graceTimer);
    if (on) { t.hover = true; positionBadges(el, t); }
    else {
      // grace so the cursor can travel image -> badge without flicker
      t.graceTimer = setTimeout(function () { t.hover = false; positionBadges(el, t); }, 150);
    }
  }

  D.on("detected", function (det) {
    var el = det.element;
    if (tracked.get(el)) return;
    var t = { badges: [], hover: false, graceTimer: 0 };
    tracked.set(el, t);
    det.bars.forEach(function (bar) {
      var badge = document.createElement("img");
      badge.className = "stk";
      badge.src = ICON_URL;
      badge.alt = "";
      badge.title = bar.identifier + (det.bars.length > 1 ? "\n1 of " + det.bars.length + " bars" : "");
      root.appendChild(badge);
      badge.addEventListener("mouseenter", function () { setHover(el, true); });
      badge.addEventListener("mousemove", function () { if (!t.hover) setHover(el, true); });
      badge.addEventListener("mouseleave", function () { setHover(el, false); });
      badge.addEventListener("click", function (ev) {
        ev.stopPropagation();
        openCommandCard(badge.getBoundingClientRect(), bar, badge);
      });
      t.badges.push({ el: badge, bar: bar });
    });
    // mouseenter alone misses a cursor ALREADY inside the image (at load or a mode flip)
    // — mousemove catches that; the !hover guard keeps it one-shot.
    el.addEventListener("mouseenter", function () { setHover(el, true); });
    el.addEventListener("mousemove", function () { if (!t.hover) setHover(el, true); });
    el.addEventListener("mouseleave", function () { setHover(el, false); });
    positionBadges(el, t);
  });

  D.on("removed", function (e) {
    var t = tracked.get(e.element);
    if (!t) return;
    t.badges.forEach(function (b) {
      if (b.el === activeBadge) { activeBadge = null; closeCard(); }
      b.el.remove();
    });
    tracked.delete(e.element);
  });

  D.on("reposition", function () { refreshAll(); placeCard(); });

  // ---- the command card (window-aware: re-clamps whenever it grows) ----
  var card = null, cardAnchor = null, cardRO = null;
  function closeCard() {
    if (cardRO) { cardRO.disconnect(); cardRO = null; }
    if (card) { card.remove(); card = null; cardAnchor = null; }
    if (activeBadge) { activeBadge = null; refreshAll(); }   // let the held marker follow hover again
  }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  function placeCard() {
    if (!card || !cardAnchor) return;
    var w = card.offsetWidth, h = card.offsetHeight;
    var left = Math.max(8, Math.min(cardAnchor.right - w, innerWidth - w - 8));
    var top = Math.max(8, Math.min(cardAnchor.bottom - 16, innerHeight - h - 8));
    card.style.left = left + "px";
    card.style.top = top + "px";
  }

  function cardAt(anchor) {
    closeCard();
    cardAnchor = { right: anchor.right, bottom: anchor.bottom };
    card = document.createElement("div");
    card.className = "card";
    card.innerHTML = '<div class="strip"><i></i><i></i><i></i></div><div class="body"></div>';
    root.appendChild(card);
    placeCard();
    cardRO = new ResizeObserver(placeCard);          // re-clamp as verify results / details grow
    cardRO.observe(card);
    return card.querySelector(".body");
  }

  // The minimal command card for ONE bar: identifier + hash, the commands, a collapsible
  // "what is this?". `bar` carries the identifier + contentHash decoded from the pixels,
  // so verify targets exactly this bar (right one in a multi-bar image, not just the bottom).
  function openCommandCard(anchorRect, bar, badgeEl) {
    var body = cardAt(anchorRect);                   // cardAt -> closeCard cleared activeBadge; re-set it now
    activeBadge = badgeEl || null;
    body.innerHTML =
      '<div class="idl"><b>' + esc(bar.identifier) + '</b><br>' +
      '<span class="hsh">hash ' + esc(bar.contentHash) + '</span></div>' +
      '<div class="acts">' +
      '<button data-verify>verify</button>' +
      '<button data-fetch>fetch record</button>' +
      '<button data-opts>options</button></div>' +
      '<div class="out" data-out></div>' +
      '<details><summary>what is this?</summary><div>' + esc(WHAT_IS_THIS) + '</div></details>';
    var out = body.querySelector("[data-out]");

    body.querySelector("[data-verify]").addEventListener("click", function () {
      out.innerHTML = '<span class="steps">verifying…</span>';
      send({ t: "verify", identifier: bar.identifier, contentHash: bar.contentHash }).then(function (res) {
        if (!card) return;
        if (!res) { out.innerHTML = '<span class="steps">The extension did not respond. Try again.</span>'; return; }
        if (res.state === "nosource") {
          out.innerHTML = '<span class="plain">No record sources are set. Set them in options, then verify.</span>';
          return;
        }
        var v = VERDICTS[res.state] || VERDICTS.error;
        var html = '<div class="vline"><span class="dot" style="background:' + v.color + '"></span>' +
          '<span class="word" style="color:' + v.color + '">' + v.word + '</span></div>' +
          '<details><summary>details</summary><div>' + esc(v.why) +
          (res.reason ? "<br><br>" + esc(res.reason) : "") +
          (res.detail ? "<br><br>" + esc(res.detail) : "") +
          (res.source ? "<br><br>source: " + esc(res.source) : "") + '</div></details>';
        if (res.recordUrl) html += '<div style="margin-top:6px"><a href="' + esc(res.recordUrl) +
          '" target="_blank" rel="noopener noreferrer">open record ↗</a></div>';
        out.innerHTML = html;
      });
    });

    body.querySelector("[data-fetch]").addEventListener("click", function () {
      out.innerHTML = '<span class="steps">fetching record…</span>';
      send({ t: "fetchrec", identifier: bar.identifier }).then(function (res) {
        if (!card) return;
        if (!res) { out.innerHTML = '<span class="steps">The extension did not respond. Try again.</span>'; return; }
        if (res.noSource) { out.innerHTML = '<span class="plain">No record sources are set. Set them in options.</span>'; return; }
        if (res.notFound) { out.innerHTML = '<span class="plain">' + esc(res.detail || "No source has a record for this identifier.") + '</span>'; return; }
        if (res.error) { out.innerHTML = '<span class="plain">' + esc(res.error) + '</span>'; return; }
        out.innerHTML = '<span class="plain">Record found. </span><a href="' + esc(res.url) +
          '" target="_blank" rel="noopener noreferrer">open record ↗</a>';
      });
    });

    body.querySelector("[data-opts]").addEventListener("click", function () {
      send({ t: "openOptions" });
    });
  }

  function openNoBarCard(anchorRect) {
    var body = cardAt(anchorRect);
    body.innerHTML = '<div class="plain">This image has no Mememage bar.</div>' +
      '<details><summary>why?</summary><div>' + esc(WHY_NO_BAR) + '</div></details>';
  }

  function openErrorCard(anchorRect, message) {
    // Distinct from "no bar": the image couldn't even be read — separates physics
    // (bar destroyed) from plumbing (fetch failed).
    var body = cardAt(anchorRect);
    body.innerHTML = '<div class="plain">The extension could not read this image.</div>' +
      '<details open><summary>details</summary><div>' + esc(message) + '</div></details>';
  }

  // Dismissal: click anywhere OUTSIDE the overlay closes the card (shadow events retarget
  // to the host, so an outside click's target is never the host). Hover never dismisses.
  document.addEventListener("mousedown", function (ev) {
    if (card && ev.target !== host) closeCard();
  }, true);
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closeCard(); }, true);

  // ---- right-click entry (message from the SW) ----
  // Ask the detector to deep-decode the URL (it markers on success), then open the card
  // on the bottom-most bar. The detector owns the decode; the UI owns the card.
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.t !== "mm-verify-at" || !msg.url) return;
    var match = null;
    document.querySelectorAll("img").forEach(function (img) {
      if (!match && (img.currentSrc === msg.url || img.src === msg.url)) match = img;
    });
    var rect = match ? match.getBoundingClientRect()
                     : { right: innerWidth / 2 + 150, bottom: innerHeight / 2 };
    var body = cardAt(rect);
    body.innerHTML = '<span class="steps">reading pixels… scanning for bars…</span>';
    D.detectAt(msg.url, match).then(function (res) {
      if (!card) return;
      if (res.blob) { openErrorCard(rect, "The page holds this image as a blob URL. The extension could not read it."); return; }
      if (res.error) { openErrorCard(rect, res.error); return; }
      if (res.found && res.detection && res.detection.bars.length) {
        var bottom = res.detection.bars[0];
        var t = match && tracked.get(match);
        var badge0 = t && t.badges[0] ? t.badges[0].el : null;
        openCommandCard(badge0 ? badge0.getBoundingClientRect() : rect, bottom, badge0);
      } else openNoBarCard(rect);
    });
  });

  // Subscriptions are registered — start the detector (guarantees no missed early emits).
  D.start();
})();
