// Mememage extension — DETECTOR ADAPTER (content script, loads AFTER the vendored
// detector library, BEFORE content.js).
//
// The detection engine now lives in the `mememage-detector` package, vendored at
// vendor/mememage-detector.js (which set window.MememageDetector = { createDetector }).
// This adapter is the extension's binding: it injects the ONE dependency the engine
// needs — decode/scan over the service worker — and hands the constructed instance to
// content.js as window.MememageDetector (the same API content.js already consumes).
//
// The engine owns discovery, geometry, lifecycle, and the mememage:detected/removed
// DOM events. This file owns ONLY the chrome transport. See
// docs/plans/extension-extensibility.md and the package README.
(function () {
  "use strict";

  // Idempotent across re-injections: if we already built the instance, restore it (the
  // vendored lib re-runs on re-injection and resets the global to its factory namespace).
  if (window.__mememageDetectorInstance) { window.MememageDetector = window.__mememageDetectorInstance; return; }

  var factory = window.MememageDetector && window.MememageDetector.createDetector;
  if (typeof factory !== "function") return;         // vendored lib missing — nothing to bind

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

  var debug = false;
  try { debug = !!localStorage.getItem("mememage-debug"); } catch (e) {}

  var instance = factory({
    // scan = the cached throughput path (auto-discovery); decode = a fresh explicit read.
    scan: function (url) { return send({ t: "scan", url: url }); },
    decode: function (url) { return send({ t: "decode", url: url }); },
    options: { debug: debug },
  });

  window.__mememageDetectorInstance = instance;
  window.MememageDetector = instance;                // content.js consumes this
})();
