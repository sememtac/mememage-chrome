// Mememage extension — toolbar popup: the whole settings surface. Saves as you type.
(function () {
  "use strict";
  // Must match DEFAULT_SOURCES / DEFAULT_TIMEOUT_MS in background.js. A fresh
  // install shows these two public reference mirrors so verify works out of the box.
  var DEFAULT_SOURCES = "https://souls.mememage.art/\nhttps://archive.org/download/{id}/";
  var DEFAULT_TIMEOUT_MS = 5000;

  var srcEl = document.getElementById("sources");
  var toEl = document.getElementById("timeout");
  var modeEl = document.getElementById("mode");
  var sideEl = document.getElementById("side");
  var savedEl = document.getElementById("saved");
  var savedTimer = null;

  chrome.storage.sync.get(
    { sources: null, source: "", timeoutMs: DEFAULT_TIMEOUT_MS, markerMode: null, markers: null, side: "right" },
    function (cfg) {
      // `sources` is the current key. Fall back to the legacy single `source`, then
      // to the defaults, so an upgrade keeps the old value and a fresh install sees
      // the two mirrors it already uses.
      srcEl.value = (cfg.sources != null) ? cfg.sources : (cfg.source || DEFAULT_SOURCES);
      toEl.value = Math.round((Number(cfg.timeoutMs) || DEFAULT_TIMEOUT_MS) / 1000);
      modeEl.value = (cfg.markerMode === "always" || cfg.markerMode === "off" || cfg.markerMode === "hover")
        ? cfg.markerMode
        : (cfg.markers === false ? "off" : "hover");   // legacy boolean migration
      sideEl.value = cfg.side === "left" ? "left" : "right";
    });

  function save() {
    var secs = Math.max(1, Math.min(60, Math.round(Number(toEl.value) || DEFAULT_TIMEOUT_MS / 1000)));
    chrome.storage.sync.set(
      { sources: srcEl.value, timeoutMs: secs * 1000, markerMode: modeEl.value, side: sideEl.value },
      function () {
        savedEl.classList.add("on");
        clearTimeout(savedTimer);
        savedTimer = setTimeout(function () { savedEl.classList.remove("on"); }, 1200);
      });
  }
  srcEl.addEventListener("input", save);
  toEl.addEventListener("input", save);
  modeEl.addEventListener("change", save);
  sideEl.addEventListener("change", save);
})();
