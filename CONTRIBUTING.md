# Contributing

Thank you for helping. This is the Mememage Chrome extension — a detector of Mememage bars
with a default UI. You can contribute here, or build your own thing on top (see `API.md`).

## Get started

1. Clone the repo.
2. Open Chrome, go to `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, and select this directory.
3. Read `ARCHITECTURE.md` — it maps the three concerns (detector, resolver, SDK) and the
   two runtimes (service worker + content scripts).

## Run the tests

The machine test loads the real extension into Chromium with Playwright and drives the
whole flow — stickers, verdicts, the card, dynamic content, the event API. It is the
behavioral contract.

```bash
pip install playwright && python -m playwright install chromium
python3 machine-test.py
```

It opens a browser window, because MV3 service workers do not start in headless mode here.
The fixtures under `testpage/` are minted by the Mememage Python core; `gen-testpage.py`
regenerates them.

## The contract

**A change is acceptable when the machine test stays green, and new behavior adds new
checks.** If you add a feature, add a check for it. If you fix a bug, add a check that
fails before your fix and passes after. The test is how we accept outside changes safely.

## Conventions

- **Vanilla JS, no build step.** The extension loads as-is. Do not add a bundler or a
  framework.
- **Do not edit `vendor/`.** That is the `mememage` SDK, vendored verbatim. The extension
  has no bar logic of its own. To change decode or verify, fix the SDK upstream, then
  re-sync with `./sync-vendor.sh`.
- **Keep the layers separate.** The detector (`detector.js`) is image-only — no network,
  no records. Record resolution (sources, timeout, verify) is the resolver, in the service
  worker. The UI (`content.js`) draws and calls the resolver. See `ARCHITECTURE.md`.
- **User-facing copy is Simplified Technical English.** Short sentences, active voice, one
  term per concept (sticker / bar / record / source / image), no jargon. This covers
  verdicts, tooltips, error messages, and labels.
- **Syntax-check Python with `ast`, not `py_compile`.** `py_compile` writes `__pycache__`,
  which Chrome then refuses to load (it rejects `_`-prefixed names). Use
  `python3 -c "import ast; ast.parse(open('f.py').read())"`.

## Pull requests

- Describe the change and why.
- Keep it focused — one concern per PR.
- Make sure `machine-test.py` passes, and add checks for new behavior.
- Match the surrounding code's style.

## Building on the extension instead

If you want to react to detections rather than change the extension, you do not need to
fork. Listen for the `mememage:detected` DOM event — see `API.md` and `examples/`.
