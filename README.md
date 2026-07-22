# Mememage — Chrome extension

See and verify Mememage provenance while you browse. The extension puts a small M/Y/C **marker** on any image whose bar decodes. Click the marker to see the image's identifier and content hash. To run a thorough check on any image, right-click it and choose **Verify with Mememage**. This deep scan also finds relocated and pasted bars. Everything runs on your machine, by math alone. The extension uses the vendored `mememage` SDK (synced verbatim from `packaging/js`). It has no bar logic of its own.

By default, the marker shows only while your cursor is over the image. You can set this to hover, always, or off. The marker sits directly above the bar, centered on a color barrier: the M/Y/C block on the left, or the C/Y/M block on the right. The "anchor on" setting picks which side. An image can carry more than one bar, stamped by different parties at different heights. Each bar gets its own marker, and a click verifies that one bar. The settings are in the **toolbar popup** (click the M/Y/C icon).

**Record sources (mirrors).** The extension looks a record up by its identifier. Set one or more sources in the popup, one per line. The extension tries them top to bottom. It uses the first source that has the record. If one host is down, the next one answers. A record is always verified by its hash against the bar. The source is never trusted. A mirror can only fail to verify. It can never fake a match. Put `{id}` in a source to expand it to the identifier (for example, `https://archive.org/download/{id}/`). Set the per-source timeout to control how long the extension waits before it tries the next source. A fresh install starts with two public mirrors: `souls.mememage.art` and the Internet Archive. Clear the field to read identifiers only.

For the design and UX rationale, see `docs/plans/extension.md` and the mockup beside it.

## Try it (load unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this directory (`packaging/extension`).
4. The M/Y/C icon appears in the toolbar. Click it to open the settings popup.

## Test drive against real minted images

```bash
python3 packaging/extension/testserver.py 8017   # serves testpage/ + the resolution-mismatch routing
```

1. In the toolbar popup, set **Record sources** to `http://localhost:8017/records`.
2. Open `http://localhost:8017`. Each bar gets a marker. Images 1 to 3 give **VERIFIED**, **ALTERED**, and **IDENTIFIED**. Image 5 carries **two bars**, and each marker verifies to its own record. Image 4 has no bar. Right-click it to get **NO BAR**.

The Python core mints the fixtures. `gen-testpage.py` regenerates them.

## Machine test

```bash
python3 packaging/extension/machine-test.py
```

This loads the real extension into Chromium with Playwright and drives the whole flow: markers, verdicts, right-click, source states, and the toggle. It opens a browser window. MV3 service workers do not start in headless mode here.

## Layout

```
manifest.json     MV3; SW module + content script + options
background.js     service worker — ALL decode/verify (the vendored SDK)
content.js        markers + verdict card (shadow-DOM overlay); no bar logic
popup.html/.js    settings popup (OG-card header) — record source, marker mode, side
fonts/            JetBrains Mono woff2 (bundled, OFL); matches the site font
vendor/mememage/  the SDK, verbatim (re-sync: ./sync-vendor.sh)
testpage/         live fixtures, minted by the Python core (gen-testpage.py)
```

## Dynamic content

The extension handles these `<img>` patterns: images added by SPA navigation, `srcset`, lazy-loaded images (a blank `<img>` whose real `src` arrives later), and carousels (an `<img>` whose `src` changes in place). Each one re-scans on the new `src`, and the scan stays viewport-lazy.

The extension also handles a `blob:` URL. Many apps preview a locally-selected file with `URL.createObjectURL`, for example the Mememage decoder's own preview and lightbox. A blob URL is page-scoped. The service worker cannot fetch it. The content script shares the page origin. It re-encodes the loaded image to a data URL for the service worker (the same path a `<canvas>` uses).

It also handles two non-`<img>` surfaces. For a CSS `background-image`, the service worker fetches the background URL. Cross-origin is fine here. For an image drawn to a `<canvas>`, the extension re-encodes the canvas to a PNG data URL, and the service worker decodes that. A cross-origin canvas taints and cannot be read. The extension skips it. Background-image discovery walks the DOM once per element (capped). It is the one surface with a small scan cost on very large pages.

## Build on it (the event API)

The extension detects Mememage bars and, on each detection, dispatches a
`mememage:detected` DOM event (and `mememage:removed` when one goes away). You can
listen for it and do anything — play a song, open your own panel, badge the image your
way — while the extension is installed. The event is cancelable: call `preventDefault()`
to suppress the default marker and draw your own. See `API.md` for the event contract,
and `examples/` for two small listeners (`log-detections.js`, `custom-badge.js`).

The extension is not yet published on the Chrome Web Store.
