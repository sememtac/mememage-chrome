# Architecture

The extension is a **detector of Mememage bars** with a default UI. It is built so you
can build on it: consume the detections and do your own thing (see `API.md`), or read
this and fork.

## Three concerns

The extension separates three jobs. None of them is "the marker" — the marker is one
consumer of the first.

| Concern | Answers | Network? | Where |
|---|---|---|---|
| **Detector** | which images carry a bar, and where is it on screen? | no | `detector.js` |
| **Resolver** | given an identifier, fetch the record from the configured mirrors | **yes** | `background.js` |
| **SDK** | do these pixels hold a bar? does this record match this hash? | no | `vendor/mememage/` |

Record resolution is not an image concern, so it is not in the detector. The detector is
image-only. Verifying a record — sources, timeout, mirror fallback, the hash check — is
the resolver's job.

## Two runtimes, one asymmetry

An MV3 extension has two JavaScript runtimes, and they are not symmetric:

- The **service worker** (`background.js`) is a module. It `import`s the vendored SDK and
  runs all decode and verify math. It hosts two capabilities:
  - **DECODE-PROXY** — decode an image's pixels to bars (for the detector). Handlers:
    `scan`, `decode`.
  - **RESOLVER** — resolve an identifier to a record over the mirrors, with a timeout,
    then check the hash (the network layer). Handlers: `verify`, `fetchrec`. Owns the
    sources + timeout config.
- The **content scripts** run on the page. They are **not** modules — an MV3 content
  script cannot `import`. So they are plain scripts, and they reach the SDK only by
  messaging the service worker. Two files, loaded in order:
  - `detector.js` (first) — the detection engine. Discovery, scan orchestration, geometry,
    lifecycle. Exposes one global, `window.MememageDetector`, and dispatches the public
    `mememage:detected` / `mememage:removed` DOM events.
  - `content.js` (second) — the UI. It subscribes to the detector, draws the markers and
    the command card, and calls the resolver (via the service worker) to verify.

This asymmetry is why the detector is a plain script exposing a global, not an ES module.

## How the pieces connect

```
service worker (module)                       content scripts (plain, isolated world)
  ┌─────────────────────┐                       ┌──────────────────────────────────┐
  │ DECODE-PROXY        │  ── scan / decode ──▶  │ detector.js                      │
  │  imports the SDK    │  ◀── bars ─────────    │  discovery + geometry + events   │
  │                     │                        │  window.MememageDetector         │
  │ RESOLVER            │  ◀── verify/fetchrec ─ │        │ on(detected/removed/…)   │
  │  mirrors + timeout  │  ── verdict ─────────▶ │        ▼                          │
  └─────────────────────┘                        │ content.js (UI: markers + card) │
                                                 └──────────────────────────────────┘
                                                          │ mememage:detected (DOM event)
                                                          ▼  page scripts / userscripts / you
```

The content side never imports the SDK. The service worker is the single SDK consumer,
and it adapts the SDK's output to the message shape the detector consumes.

## The SDK is vendored, never forked

`vendor/mememage/` is a verbatim copy of the `mememage` npm package (the JavaScript SDK
for the Mememage protocol). The extension has **no bar logic of its own**. Re-sync it with
`./sync-vendor.sh` after the SDK updates. Do not edit files under `vendor/` — fix the SDK
upstream. The parity chain (Python core → SDK) is what keeps decode correct; the extension
rides on it.

## File map

```
manifest.json     MV3; SW module + two ordered content scripts + the popup
background.js     service worker — DECODE-PROXY + RESOLVER (all SDK math here)
detector.js       content script (loads first) — the detection engine + event API
content.js        content script (loads second) — the UI (markers + command card)
popup.html/.js    the settings popup (record sources, timeout, marker mode, side)
vendor/mememage/  the SDK, verbatim (re-sync: ./sync-vendor.sh) — do not edit
fonts/            JetBrains Mono woff2, bundled (extension pages can't fetch web fonts)
API.md            the in-page event API (mememage:detected / mememage:removed)
examples/         two listeners built on the event API
testpage/         live fixtures for the machine test, minted by the Python core
```

## Testing

`machine-test.py` loads the real extension into Chromium and drives the whole flow. It is
the behavioral contract — see `CONTRIBUTING.md`.
