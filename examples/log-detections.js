// Example: log every Mememage detection.
//
// The simplest consumer of the in-page event API. It listens for the extension's
// `mememage:detected` events and logs each bar. Run it as a userscript, or paste it
// into the console on a page that has Mememage images (with the extension installed).
//
// See API.md for the full event contract.

addEventListener("mememage:detected", function (e) {
  var el = e.target;                 // the carrier: <img>, <canvas>, or a background host
  var d = e.detail;                  // plain data — see API.md
  d.bars.forEach(function (bar) {
    console.log("[mememage] detected", bar.identifier,
      "hash", bar.contentHash, "on", el.tagName.toLowerCase(),
      "(" + d.scanWidth + "x" + d.scanHeight + ")");
  });
}, true);

addEventListener("mememage:removed", function (e) {
  console.log("[mememage] removed", e.target.tagName.toLowerCase());
}, true);
