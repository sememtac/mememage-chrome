# Chrome Web Store listing — Mememage extension

Copy-paste source for the CWS developer console. Version 1.0.0.
Publisher: **Catmemes** · Contact: andy.xiao@gmail.com · Privacy: https://mememage.art/privacy

---

## Name
The store title comes from the package (`manifest.json` name) = **Mememage**.

## Summary  (from the package `manifest.json` description — max 132 chars)
`Spot and verify Mememage-marked images while you browse. A marker appears on each one. Everything runs in your browser.`

(115 chars. Scoped to Mememage-marked images — the extension only acts on images
that carry a Mememage bar, so a broad "image provenance" claim would overreach.)

## Category
**Primary: Privacy & Security.** The extension verifies image integrity and reads the record a Mememage bar points to — a security/authenticity tool.
Alternates if that slot is unavailable: **Photos**, then **Developer Tools**.

## Language
English

---

## Detailed description  (paste into "Description")

Spot Mememage-marked images, and verify them — without leaving the page.

A Mememage bar is a tiny 2-pixel mark at the bottom of an image. It carries an identifier and a content hash that point to the image's record. This extension reads that bar and puts a small marker on any image that has one. Click the marker to check the image against its record.

Everything runs in your browser, by math alone. No account. No sign-in. No tracking.

WHAT YOU SEE

• A small marker appears on any image that carries a Mememage bar — on any site.
• Click the marker to see the image's identifier and content hash, and to verify it.
• Right-click any image and choose "Verify with Mememage" for a deeper scan that also finds moved or pasted bars.

THE VERDICTS

• VERIFIED — the record matches the image by content hash. The data is intact and belongs to these pixels.
• IDENTIFIED — the extension read the bar and found the record. The identity is confirmed. This record uses a hash model the extension does not implement (it checks the open model). The extension cannot check this record's integrity. This is not tampering.
• ALTERED — the record does not match. The data changed, or it is the wrong record.
• NO RECORD — the bar is valid, but no record was found at your sources.

RECORD SOURCES (MIRRORS)

You choose where records are looked up. List one or more sources; the extension tries them top to bottom and uses the first that has the record. So if one host is down, the next answers. A record is always verified by its hash against the bar — the source is never trusted. A fresh install includes two public mirrors, the Internet Archive and souls.mememage.art. Change or clear them any time. Set a per-source timeout to control how long the extension waits before it tries the next source.

PRIVACY

The extension collects nothing. No analytics, no telemetry, no account. Image decoding happens in your browser. The only network requests are the image bytes (usually a cache hit) and — only when you click — a record lookup from the sources you configured. Full policy: https://mememage.art/privacy

OPEN SOURCE

Mememage is free and MIT licensed. The extension uses the same verification math as the Mememage core, with no bar logic of its own. Source: https://github.com/sememtac/mememage-chrome

Learn more at https://mememage.art

---

## Single purpose  (paste into "Single purpose description")

The extension has one purpose: to detect and verify Mememage provenance bars in images on web pages. It marks images that carry a bar, and on the user's click it looks up and verifies the image's record by content hash. All verification runs locally.

---

## Permission justifications  (paste each into the matching field)

**Host permission — all sites (`<all_urls>`):**
The extension marks and verifies images that carry a Mememage bar on any page the user visits. To do this, it reads image pixels on those pages to decode the bar. It reads image data only. It does not read page text, form input, or browsing history. Broad host access is required for two reasons. Provenance images can appear on any site. The marker is also passive, and it must work on every site without per-site activation by the user.

**Storage:**
Saves the user's settings on their machine: the record sources, the per-source timeout, the marker mode, and the anchor side. Nothing is sent anywhere.

**Context menus:**
Adds the right-click "Verify with Mememage" item, which runs a deeper scan of the selected image.

**Remote code:** No. The extension runs only the code in the package. It executes no remote or eval'd code. The vendored SDK is bundled in the package.

---

## Data usage disclosures  (CWS "Privacy practices" tab)

Check: **the extension does NOT collect or use user data.**

- Does your extension collect personally identifiable information? **No.**
- Health information? **No.**
- Financial and payment information? **No.**
- Authentication information? **No.**
- Personal communications? **No.**
- Location? **No.**
- Web history? **No.**
- User activity? **No.**
- Website content? **No.** (Image pixels are read locally to decode the bar and are never transmitted or stored.)

Certifications (check all three):
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

---

## Assets checklist

- Icon: 128×128 (icons/icon128.png) — in the package.
- Screenshots: 1280×800 — store/screenshots/ (1 genesis + IDENTIFIED card, 2 genesis + marker, 3 popup, 4 VERIFIED on an open-model record). Order 1-4.
- Small promo tile 440×280: TODO (optional but recommended).
- Marquee 1400×560: optional, skip.
- Package: build with `bash build-store-zip.sh` → store/mememage-chrome-1.0.0.zip.
