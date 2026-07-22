// Mememage extension — service worker. ALL decode/verify logic lives here, and all of
// it is the vendored SDK (packaging/js, synced by sync-vendor.sh) — the extension has
// no bar logic of its own. The content script only watches images and draws UI.
//
// The SW hosts TWO distinct capabilities (see docs/plans/extension-extensibility.md):
//   • DECODE-PROXY — decode this image's pixels to bars, for the DETECTOR (content
//     script). No records, no mirrors. Handlers: scan / decode.
//   • RESOLVER     — resolve an identifier to a record over the configured mirrors,
//     with a timeout, then check the hash. The network layer. Handlers: verify /
//     fetchrec. Owns the sources + timeout config.
//
// Two-tier scanning (the performance contract from docs/plans/extension.md):
//   fast scan  — passive sticker detection: bottom-anchored decode only ({scan:false}),
//                min-size gate, per-URL cache. Cheap; runs as images enter the viewport.
//   deep scan  — explicit right-click: the full vertical/anywhere scan (SDK default),
//                catches relocated / pasted bars.
//
// Privacy: everything is local. Image bytes are fetched with cache:"force-cache" and
// no credentials (normally a browser-cache hit, not a new download). The only other
// network is fetching <source>/<identifier>.json from the record source the USER
// configured, and only when they click.

import { decode, verify, loadPixels, extractBars,
         computeContentHash, isSupportedHashVersion } from "./vendor/mememage/index.js";

const MIN_W = 200, MIN_H = 48;          // passive gate: smaller can't carry a readable bar
const scanCache = new Map();            // url -> fast-scan result (best-effort; SW may sleep)
const CACHE_MAX = 500;

function remember(url, result) {
  if (scanCache.size >= CACHE_MAX) scanCache.delete(scanCache.keys().next().value);
  scanCache.set(url, result);
  return result;
}

async function pixelsFor(url) {
  // force-cache only for http(s) — a data: URL (a re-encoded canvas) has no HTTP cache
  // and some engines reject the cache option on non-http schemes.
  const opts = { credentials: "omit" };
  if (/^https?:/.test(url)) opts.cache = "force-cache";
  const resp = await fetch(url, opts);
  if (!resp.ok) throw new Error("The image did not load (status " + resp.status + ").");
  return await loadPixels(await resp.blob());
}

// ===== DECODE-PROXY (for the detector) — decode pixels to bars; no records =====
// Passive pass: find EVERY bar in the image, each with its vertical position, so the
// content script can sticker each one where it sits. extractBars is the deep scan (it
// runs the same edge + anywhere passes as a right-click) — an image can be stamped by
// more than one party, and a single sticker would hide that. bottomRow is the bar's
// bottom row in NATIVE pixels; the content script maps it to display coords via the
// <img>'s naturalHeight. (Position is not in the SDK's public decode(allBars) — it
// comes from extractBars' per-bar bottomRow. Flagged for Andy: if multi-bar-with-
// position becomes first-class, the Python core should expose bottom_row too.)
async function fastScan(url) {
  if (scanCache.has(url)) return scanCache.get(url);
  try {
    const src = await pixelsFor(url);
    if (src.width < MIN_W || src.height < MIN_H) return remember(url, { found: false, skipped: "too small" });
    const px = src.pixels || src.data;
    const bars = extractBars(px, src.width, src.height).map(function (b) {
      return { identifier: b.identifier, contentHash: b.content_hash,
               bottomRow: b.bottomRow, left: b.left, right: b.right };
    });
    // width/height = the SW-decoded pixel dims, i.e. the coordinate space bottomRow &
    // the barriers live in. The displayed <img> may be a DIFFERENT resolution of the
    // same image (responsive/CDN resize), so the content script maps by fraction, not
    // by the displayed naturalHeight.
    return remember(url, bars.length
      ? { found: true, width: src.width, height: src.height, bars: bars }
      : { found: false });
  } catch (e) {
    return remember(url, { found: false, error: String((e && e.message) || e) });
  }
}

// ===== RESOLVER (record resolution) — identifier -> record over mirrors =====
// --- Record sources (mirrors) ------------------------------------------------
// The user configures an ORDERED list of sources — one per line, tried top to
// bottom. A record is always verified by hashing it against the bar in the
// pixels, so the SOURCE is never trusted: a mirror can only fail to verify, it
// can never forge a match. That makes the list pure AVAILABILITY — take the
// FIRST source that has the record. A source may hold "{id}", expanded to the
// identifier before the probe, so a flat host (souls.mememage.art/) and Internet
// Archive's per-item folder (archive.org/download/{id}/) share one code path
// (the same convention the decoder and validator use).
//
// Defaults (a fresh install, before the user opens the popup) are the two public
// reference mirrors, so verify works out of the box on mememage.art images. The
// popup shows the same two lines; clear the field to read identifiers only.
const DEFAULT_SOURCES = "https://souls.mememage.art/\nhttps://archive.org/download/{id}/";
const DEFAULT_TIMEOUT_MS = 5000;

function parseSources(raw) {
  return String(raw || "").split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
}

async function sourceList() {
  // `sources` is the current key. A pre-mirror install stored a single `source`;
  // seed it as line 1. A never-configured install (both unset) gets the defaults.
  const cfg = await chrome.storage.sync.get({ sources: null, source: "" });
  let raw;
  if (cfg.sources != null) raw = cfg.sources;        // user set it (may be "" = identifiers only)
  else if (cfg.source) raw = cfg.source;             // legacy single source
  else raw = DEFAULT_SOURCES;                         // fresh install
  return parseSources(raw);
}

async function timeoutMs() {
  const cfg = await chrome.storage.sync.get({ timeoutMs: DEFAULT_TIMEOUT_MS });
  const n = Number(cfg.timeoutMs);
  return isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function expandBase(base, identifier) {
  return base.replace(/\{id\}/g, identifier).replace(/\/+$/, "");
}

// Probe ONE source. Returns { record, url } on a hit, { notFound: true } when the
// host answered but has neither <id>.json nor <id>.soul, or { blocked, error } when
// the host timed out, did not respond, or returned a non-404 status. On a blocked
// host the .soul retry is skipped — the same host is down, so move to the next mirror.
async function fetchFromSource(base, identifier, ms) {
  const root = expandBase(base, identifier);
  for (const ext of ["json", "soul"]) {
    const url = root + "/" + identifier + "." + ext;
    let resp;
    try {
      resp = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(ms) });
    } catch (e) {
      const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
      return { blocked: true, error: timedOut
        ? "timed out after " + (ms / 1000) + "s"
        : "no response (unreachable, or blocked)" };
    }
    if (resp.ok) {
      try { return { record: await resp.json(), url: url }; }
      catch (e) { return { blocked: true, error: "returned data that is not JSON" }; }
    }
    if (resp.status !== 404) return { blocked: true, error: "status " + resp.status };
    // 404 -> this host answered but lacks this extension; try .soul, then next source
  }
  return { notFound: true };
}

// Walk the mirror list; the first source with the record wins. On total failure,
// report enough to tell "none had it" (every host answered 404) apart from "none
// answered" (timeout / unreachable / bad status on one or more).
async function resolveRecord(identifier) {
  const sources = await sourceList();
  if (!sources.length) return { noSource: true };
  const ms = await timeoutMs();
  let anyNotFound = false, anyBlocked = false, lastError = null;
  for (const base of sources) {
    const r = await fetchFromSource(base, identifier, ms);
    if (r.record) return { record: r.record, url: r.url, source: base };
    if (r.notFound) anyNotFound = true;
    else if (r.blocked) { anyBlocked = true; lastError = r.error; }
  }
  return { notFound: true, tried: sources.length,
           anyNotFound: anyNotFound, anyBlocked: anyBlocked, lastError: lastError };
}

// One-line summary of a total-failure resolveRecord result, for the card.
function triedSummary(res) {
  const n = res.tried || 0;
  const many = n === 1 ? "1 source" : n + " sources";
  if (res.anyBlocked && !res.anyNotFound) {
    return "Tried " + many + ". No source responded (" + (res.lastError || "blocked") + ").";
  }
  if (res.anyBlocked && res.anyNotFound) {
    return "Tried " + many + ". No source had the record, and one or more did not respond (" +
           (res.lastError || "blocked") + ").";
  }
  return "Tried " + many + ". No source has a record for this identifier.";
}

// Decode only (right-click entry) — every bar with its position, same shape as
// fastScan. No record fetch: the card offers that as a command.
async function runDecode(url) {
  try {
    const src = await pixelsFor(url);
    const px = src.pixels || src.data;
    const bars = extractBars(px, src.width, src.height).map(function (b) {
      return { identifier: b.identifier, contentHash: b.content_hash,
               bottomRow: b.bottomRow, left: b.left, right: b.right };
    });
    if (!bars.length) return { found: false };
    const out = { found: true, width: src.width, height: src.height, bars: bars };
    remember(url, out);
    return out;
  } catch (e) { return { found: false, error: String((e && e.message) || e) }; }
}

// Fetch-record command — by identifier (the card already holds it). Returns the URL
// that answered so the card can link to the record in a new tab.
async function runFetchRecord(identifier) {
  const res = await resolveRecord(identifier);
  if (res.noSource) return { noSource: true };
  if (res.record) return { ok: true, url: res.url, source: res.source };
  return { notFound: true, detail: triedSummary(res) };
}

// Verify a SPECIFIC bar the card already decoded (identifier + the hash stamped in its
// pixels). Works for every bar in a multi-bar image, not just the bottom one: fetch the
// record for this identifier, recompute its content hash, compare to the bar's. No pixel
// re-decode — the bar's hash is authoritative and already in hand. Mirrors verify()'s
// WITNESSED logic (computeContentHash + the hash_version support gate).
async function runVerifyBar(identifier, contentHash) {
  const base = { identifier: identifier, contentHash: contentHash };
  const res = await resolveRecord(identifier);
  if (res.noSource) return { state: "nosource", ...base };
  if (!res.record) {
    // A blocked source is a fetch failure (error), not an absence (norecord).
    const summary = triedSummary(res);
    return res.anyBlocked ? { state: "error", ...base, reason: summary }
                          : { state: "norecord", ...base, detail: summary };
  }

  const record = res.record, recordUrl = res.url, srcBase = res.source;
  if (!isSupportedHashVersion(record)) {
    return { state: "unsupported", ...base, source: srcBase, recordUrl: recordUrl,
             detail: "The record uses hash model " + JSON.stringify(record && record.hash_version) +
                     ". The extension checks the open model. It cannot verify this record's integrity here. " +
                     "This is not tampering." };
  }
  const recomputed = await computeContentHash(record);
  if (recomputed !== contentHash) {
    return { state: "altered", ...base, source: srcBase, recordUrl: recordUrl,
             detail: "Hash mismatch. The bar has " + contentHash + ". The record computes to " + recomputed + "." };
  }
  return { state: "verified", ...base, source: srcBase, recordUrl: recordUrl };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.t === "scan") { fastScan(msg.url).then(sendResponse); return true; }
  if (msg && msg.t === "decode") { runDecode(msg.url).then(sendResponse); return true; }
  if (msg && msg.t === "verify") { runVerifyBar(msg.identifier, msg.contentHash).then(sendResponse); return true; }
  if (msg && msg.t === "fetchrec") { runFetchRecord(msg.identifier).then(sendResponse); return true; }
  if (msg && msg.t === "openOptions") {
    // Settings live in the toolbar popup. openPopup needs a user-gesture chain Chrome
    // doesn't extend across this message, so fall back to the popup in a tab.
    (async () => {
      try { await chrome.action.openPopup(); }
      catch (e) { chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") }); }
      sendResponse({});
    })();
    return true;
  }
});

// Right-click entry — always offered, on every image; this is the DEEP scan.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "mm-verify",
    title: "Verify with Mememage",
    contexts: ["image"],
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "mm-verify" || !info.srcUrl || !tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { t: "mm-verify-at", url: info.srcUrl });
});

