// Example: replace Mememage's sticker with your own badge.
//
// `mememage:detected` is cancelable. A listener that calls preventDefault() stops the
// extension's default sticker for that detection. This example does that, then draws its
// own badge from the detection data and keeps it positioned as the page scrolls.
//
// Run it as a userscript, or paste it into the console (with the extension installed).
// See API.md for the full event contract.

(function () {
  var badges = new Map();            // element -> the badge this example created

  addEventListener("mememage:detected", function (e) {
    e.preventDefault();              // suppress the extension's default sticker
    var el = e.target, d = e.detail, bar = d.bars[0];

    var badge = document.createElement("div");
    badge.textContent = "✓ " + bar.identifier;
    badge.style.cssText =
      "position:fixed;z-index:2147483647;background:#111114;color:#7bc4a0;" +
      "font:12px ui-monospace,monospace;padding:2px 7px;border-radius:6px;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none;white-space:nowrap;";
    document.body.appendChild(badge);
    badges.set(el, badge);

    // Position the badge on the bar. This is the simple case (object-fit: fill): the bar
    // sits at bottomRow/scanHeight down the image, and left..right / scanWidth across it.
    // For pixel-perfect placement under object-fit, letterbox, object-position, or a
    // resolution mismatch, import the detector library and use its place() helper (the
    // extension's own sticker does this). See API.md.
    function place() {
      var r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.width < 40) { badge.style.display = "none"; return; }
      badge.style.display = "";
      var fx = (bar.right != null ? bar.right : d.scanWidth) / d.scanWidth;
      var fy = (bar.bottomRow != null ? bar.bottomRow : d.scanHeight) / d.scanHeight;
      badge.style.left = (r.left + fx * r.width - badge.offsetWidth - 4) + "px";
      badge.style.top = (r.top + fy * r.height - badge.offsetHeight - 4) + "px";
    }
    place();
    addEventListener("scroll", place, true);
    addEventListener("resize", place);
  }, true);

  addEventListener("mememage:removed", function (e) {
    var badge = badges.get(e.target);
    if (badge) { badge.remove(); badges.delete(e.target); }
  }, true);
})();
