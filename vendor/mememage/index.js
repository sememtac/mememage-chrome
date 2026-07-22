// mememage — the JavaScript SDK for mememage-core.
//
// The JS implementation of the Mememage protocol, complete at core parity with the
// Python reference (the `mememage` package) — decode, verify, encode, encrypt/unlock.
//
// Strictly the Mememage *core*: the universal primitive every adopter relies on
// regardless of what they store. Schema-agnostic — the content hash covers whatever
// fields a record carries — so it verifies ANY Mememage record, including the canonical
// chain's (a genesis mint is just a valid core record with extra fields it ignores).
//
//   decode / decodeBar — bar pixels -> { identifier, contentHash } (allBars for a list)
//   verify             — record vs image -> { match, reason, supported } (api.py mirror)
//   verifyWitnessed    — bare-boolean convenience form of the same integrity check
//   encode             — stamp a bar + build the record (write; + {password, private})
//   encryptField / decryptField / unlock / isEncrypted — field encryption (access layer)
//   isSupportedHashVersion — is this a hash model we implement (the "open" model)?
//
// It implements ONLY the "open" hash version — hash every field (the raw core /
// adoption model, what the raw API and ComfyUI produce). A record on a curated
// integer version (the canonical chain's hash_version 1) reads as UNSUPPORTED, not
// tampered — check isSupportedHashVersion before verifyWitnessed to tell the two
// apart, exactly as ComfyUI's verifier and the core CLI do.
//
// Deliberately NOT here — reference-implementation features, out of raw-core scope:
// signing / AUTHENTICATED (the raw core's verify() is integrity-only, "authorship/
// signatures are out of scope"; signing lives in the mint/chains/profiles pipeline),
// EMBODIED (dHash + luma grid), and the distributed watermark. Another adopter may not
// sign, may use a different tamper-evidence technique, or none. If a reference layer is
// ever ported to JS it's a separate surface with its own parity anchor.
//
// Bodies are verbatim from the parity-locked decoder (docs/js), wrapped as modules;
// test/decode-parity and test/verify-parity prove the Python core's own output
// (bars from embed_into, hashes from compute_content_hash) round-trips identically here.

export {
  extractBarScaleAware, extractBars, decodePayload, packPayload,
  extractIdentifier, normalizeIdentifier,
} from "./codec.js";
export {
  computeContentHash, isSupportedHashVersion, sha256_16,
} from "./verify.js";
export { encode, contentIdentifier } from "./encode.js";
export { encryptField, decryptField, unlock, isEncrypted } from "./crypto.js";
export { loadPixels } from "./load.js";
export { toPngBytes } from "./png.js";

import { extractBarScaleAware, extractBars } from "./codec.js";
import { computeContentHash, isSupportedHashVersion, OPEN_HASH_VERSION } from "./verify.js";
import { isRawSource as _isRawSource } from "./load.js";

/**
 * Decode a Mememage bar from raw image pixels. Mirrors api.py decode(image, all_bars).
 * @param {Uint8ClampedArray|Uint8Array} pixels flat RGBA (or RGB) as from canvas getImageData().data
 * @param {number} width
 * @param {number} height
 * @param {{scan?: boolean, fast?: boolean, allBars?: boolean}} [opts]
 *   scan (default true) finds a relocated/pasted bar; fast skips fallbacks;
 *   allBars returns EVERY bar in the image as a list (empty if none) — for
 *   images stamped by more than one party.
 * @returns {{identifier: string, contentHash: string} | null | Array}
 */
export function decode(pixels, width, height, opts) {
  // Object form: decode(await loadPixels(src), opts) — width slot carries opts.
  if (_isRawSource(pixels)) {
    opts = width;
    var s = pixels; height = s.height; width = s.width; pixels = s.pixels || s.data;
  }
  opts = opts || {};
  if (opts.allBars) {
    return extractBars(pixels, width, height).map(function (r) {
      return { identifier: r.identifier, contentHash: r.content_hash };
    });
  }
  const r = extractBarScaleAware(pixels, width, height, opts.scan !== false, !!opts.fast);
  return r ? { identifier: r.identifier, contentHash: r.content_hash } : null;
}

/** Alias of {@link decode} (single-bar form) — the SDK's original name. */
export const decodeBar = decode;

/**
 * Verify a record against an image's pixels. Mirrors api.py verify(image, record):
 * reads the bar, recomputes the content hash over the record, compares.
 *
 * Returns a Verification-shaped object `{ match, reason, supported }` — match is
 * the verdict (check it explicitly; unlike Python's truthy dataclass, any JS
 * object is truthy), reason explains a failure (empty on success), and
 * supported=false flags a hash_version this SDK doesn't implement (an
 * application-defined model — NOT tamper evidence).
 *
 * (Core verifies integrity only, by math alone — no network. Authorship /
 * signatures are out of scope.)
 * @param {Uint8ClampedArray|Uint8Array} pixels flat RGBA (or RGB)
 * @param {number} width
 * @param {number} height
 * @param {object} record the record (a plain dict of fields)
 * @returns {Promise<{match: boolean, reason: string, supported: boolean}>}
 */
export async function verify(pixels, width, height, record) {
  // Object form: verify(await loadPixels(src), record) — width slot carries record.
  if (_isRawSource(pixels)) {
    record = width;
    var s = pixels; height = s.height; width = s.width; pixels = s.pixels || s.data;
  }
  const bar = decode(pixels, width, height);
  if (bar === null) {
    return { match: false, reason: "no Mememage bar in the image", supported: true };
  }
  if (!isSupportedHashVersion(record)) {
    const hv = record ? record.hash_version : undefined;
    return {
      match: false, supported: false,
      reason: "unsupported hash_version " + JSON.stringify(hv) + ": this record uses a hash model " +
              "this SDK doesn't implement (it implements " + JSON.stringify(OPEN_HASH_VERSION) + "). " +
              "Its content hash can't be checked here — verify it with the application that " +
              "defines this version (e.g. its web decoder). Not tamper evidence; the record may be valid.",
    };
  }
  const recomputed = await computeContentHash(record);
  if (recomputed !== bar.contentHash) {
    return {
      match: false, supported: true,
      reason: "hash mismatch: image bar says " + bar.contentHash + ", data recomputes to " + recomputed,
    };
  }
  return { match: true, reason: "", supported: true };
}

/**
 * WITNESSED: does a record's recomputed content hash match the hash from the bar?
 * The core integrity check — body and soul joined, verified by math alone.
 * Bare-boolean convenience form; {@link verify} is the api.py-parity surface
 * with failure reasons.
 * @param {object} record the fetched record (any hash_version; dispatch is internal)
 * @param {string} contentHashFromBar the 16-hex hash decoded from the image's bar
 * @returns {Promise<boolean>}
 */
export async function verifyWitnessed(record, contentHashFromBar) {
  const recomputed = await computeContentHash(record);
  return recomputed != null && recomputed === contentHashFromBar;
}

