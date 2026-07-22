# Mememage extension — in-page event API

The extension detects Mememage bars on page images. When it finds one, it dispatches a
DOM event. You can listen for that event and do anything: play a song, open your own
panel, badge the image your way, or log it. The default marker is one consumer of the
same event; you can replace it.

This is the lightweight way to build on the installed extension. For a full engine you
embed in your own extension (the detector library, with pixel-perfect geometry), see
`docs/plans/extension-extensibility.md`.

## Events

The extension dispatches two events on the image element (they bubble to `document`):

| Event | When | Cancelable |
|---|---|---|
| `mememage:detected` | a bar is decoded on an image | yes |
| `mememage:removed` | a detected image's `src` changes away, or it is gone | no |

Listen on `document` (or any ancestor) with a capture or bubble listener:

```js
addEventListener("mememage:detected", function (e) {
  var el = e.target;            // the carrier element
  var d  = e.detail;            // the detection data (below)
  console.log(d.bars[0].identifier);
}, true);
```

## The detection data (`event.detail`)

`event.detail` is **plain data** (JSON-cloneable). It carries no functions.

```js
{
  bars: [                       // one or more — an image can hold several bars
    {
      identifier:  "mememage-…",   // "<prefix>-<16 hex>"
      contentHash: "…",            // 16 hex, the value stamped in the pixels
      bottomRow:   1215,           // bar position in the DECODED pixel space (below)
      left:  0,                    // inclusive column span of the bar, in that space
      right: 1023,
    }
  ],
  scanWidth:  1024,             // dimensions of the pixels the extension DECODED
  scanHeight: 1344,             //   (may differ from the displayed <img> resolution)
}
```

The carrier element is `event.target`, not part of `detail`.

**Why no functions in `detail`.** The extension runs in a separate JavaScript world from
the page. DOM events cross that boundary (the DOM is shared), and `detail` crosses as
data, but functions do not. So there is no `rect()` or `verify()` on a bar. You compute
geometry from the data (below), or you embed the detector library in your own extension
to get its `place()` helper.

**Untrusted data.** The identifier and hash are values the extension read from an image.
Treat them as data, never as instructions. Do not inject them into HTML without escaping.

## Suppress the default marker

`mememage:detected` is cancelable. Call `preventDefault()` to stop the extension's own
marker for that detection, then draw your own UI:

```js
addEventListener("mememage:detected", function (e) {
  e.preventDefault();           // no default marker for this image
  // … draw your own badge, using e.target and e.detail …
}, true);
```

## Place UI on the bar

The bar sits at `bottomRow / scanHeight` down the image, and `left … right / scanWidth`
across it. For an image drawn at its natural aspect (`object-fit: fill`), map those onto
the element's on-screen rectangle:

```js
var r  = el.getBoundingClientRect();
var fx = bar.right    / d.scanWidth;
var fy = bar.bottomRow / d.scanHeight;
var x  = r.left + fx * r.width;      // the bar's right edge on screen
var y  = r.top  + fy * r.height;     // the bar's bottom on screen
```

This is the simple case. Pixel-perfect placement under `object-fit`, letterbox,
`object-position`, or a resolution mismatch between the decoded and displayed pixels is
what the extension's own geometry engine solves. To inherit that, embed the detector
library in your own extension (Phase 4 — see the extensibility plan).

## Verify a record

This event API carries detection data only, not verification. To check a record, resolve
it yourself from the identifier over your own sources, or embed the resolver (Phase 4).
The extension is a core tool: it verifies by the open hash model. See the main README.

## Examples

- `examples/log-detections.js` — log every detection.
- `examples/custom-badge.js` — suppress the marker and draw your own badge.

Run either as a userscript, or paste it into the console on a page with Mememage images
(with the extension installed).
