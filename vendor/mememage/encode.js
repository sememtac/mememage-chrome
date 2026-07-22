// mememage — the WRITE side of the SDK. Mirrors mememage/api.py:encode.
//
// Python is the reference; this produces a byte-identical result (same record, same
// barred pixels), gated by test/encode-parity against the Python core. Pure pixels:
// the SDK operates on a raw RGBA array (as from canvas getImageData().data), never on
// image files — the consumer handles load/save. This is the public-record path (the
// `open` hash model); signing and field encryption are later phases.

import { packPayload, embedBarPayload } from "./codec.js";
import { computeContentHash, sha256_16, sortKeysDeep } from "./verify.js";
import { encryptField } from "./crypto.js";
import { isRawSource } from "./load.js";

// Reserved / prefix rules — mirror api.py:_RESERVED and _PREFIX_RE exactly.
const RESERVED = new Set(["identifier", "content_hash", "hash_version", "signature", "encrypted_fields"]);
const PREFIX_RE = /^[A-Za-z][A-Za-z0-9_-]{1,8}[A-Za-z0-9]$/;

function _validatePrefix(prefix) {
  if (typeof prefix !== "string" || !PREFIX_RE.test(prefix)) {
    throw new Error(`invalid prefix ${JSON.stringify(prefix)}: 3-10 chars, ` +
      `[A-Za-z][A-Za-z0-9_-]*[A-Za-z0-9] (URL/path/filename-safe)`);
  }
}

// Content-address: <prefix>-<16 hex of SHA-256(canonical(fields))>. Mirrors
// api.py:_content_identifier — its canonical serialization is the SAME one the content
// hash uses, so sha256_16(fields) IS exactly that 16-hex digest.
export async function contentIdentifier(fields, prefix = "mememage") {
  _validatePrefix(prefix);
  return `${prefix}-${await sha256_16(fields)}`;
}

/**
 * Write a Mememage bar into an image and build its record — the inverse of decodeBar,
 * mirroring the Python core's encode. Public-record (open) path.
 * @param {Uint8ClampedArray|Uint8Array} pixels flat RGBA (as from canvas getImageData().data). Not mutated.
 *        Also accepts the object form: encode(await loadPixels(src), fields, opts).
 * @param {number} width
 * @param {number} height  (>= 3 rows; the bar needs a reference row above it)
 * @param {object} [fields] your JSON-serializable data (reserved / `_`-prefixed keys rejected)
 * @param {{prefix?: string, identifier?: string}} [opts] prefix (default "mememage") or a pinned
 *        canonical `<prefix>-<16 hex>` identifier
 * @returns {Promise<{pixels: Uint8ClampedArray, record: object, identifier: string, contentHash: string}>}
 *        the barred pixels (a copy) + the record, with the Record-style identifier /
 *        contentHash conveniences (mirrors api.py Record properties)
 */
export async function encode(pixels, width, height, fields, opts) {
  // Object form: encode(await loadPixels(src), fields, opts) — the width/height
  // slots carry fields/opts. Same shim as decode/verify, so the whole API is
  // uniform (this asymmetry once made fields land in `width` and produced a
  // misleading "payload too large" error from NaN capacity).
  if (isRawSource(pixels)) {
    opts = height; fields = width;
    var s = pixels; height = s.height; width = s.width; pixels = s.pixels || s.data;
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("encode needs integer width/height — call encode(pixels, width, height, " +
                    "fields, opts) or encode(await loadPixels(src), fields, opts)");
  }
  opts = opts || {};
  fields = fields || {};
  for (const k of Object.keys(fields)) {
    if (RESERVED.has(k)) throw new Error(`encode computes these — don't pass them: ${k}`);
    if (k[0] === "_") throw new Error(`\`_\`-prefixed keys are reserved for decoder internals and are NOT hashed: ${k}`);
  }

  const record = { ...fields, hash_version: "open" };

  // Identity — content-addressed from your fields (stable), unless you pin one.
  let ident = opts.identifier;
  if (ident == null) {
    ident = await contentIdentifier(fields, opts.prefix || "mememage");
  } else {
    const i = ident.lastIndexOf("-");
    const pre = i > 0 ? ident.slice(0, i) : "";
    const idhex = i > 0 ? ident.slice(i + 1) : "";
    if (!(i > 0 && idhex.length === 16 && /^[0-9a-f]{16}$/.test(idhex))) {
      throw new Error(`identifier must be canonical <prefix>-<16 lower-hex>, got ${JSON.stringify(ident)}`);
    }
    _validatePrefix(pre);
  }
  record.identifier = ident;

  // Field visibility — encrypt the private fields BEFORE the hash, so the proof covers
  // the ciphertext (a tamper-evident shell that still WITNESSES without the password).
  // Mirrors api.py. Note the identifier is content-addressed from the PLAINTEXT fields
  // above, so it's stable whether or not you encrypt.
  const password = opts.password;
  if (password != null) {
    if (opts.private != null) {
      const unknown = opts.private.filter((k) => !(k in fields));
      if (unknown.length) throw new Error(`private names fields you didn't pass: ${unknown.sort()}`);
    }
    const privKeys = opts.private == null ? Object.keys(fields) : opts.private.filter((k) => k in fields);
    const priv = {};
    for (const k of privKeys) { priv[k] = record[k]; delete record[k]; }   // leaves the cleartext shell
    if (Object.keys(priv).length) {
      record.encrypted_fields = await encryptField(JSON.stringify(sortKeysDeep(priv)), password);
    }
  } else if (opts.private) {
    throw new Error("private=… needs a password=…");
  }

  // Proof — the content hash covers identity + the public shell + the ciphertext.
  const content_hash = await computeContentHash(record);
  record.content_hash = content_hash;

  // Bar the pixels on a COPY (mirror Python "works on a copy" — never mutate the caller's).
  const out = new Uint8ClampedArray(pixels);
  embedBarPayload(out, width, height, packPayload(ident, content_hash));
  // identifier/contentHash conveniences mirror api.py Record's properties;
  // width/height make the result a valid raw-pixels source, so it feeds
  // toPngBytes(result) / decode(result) / verify(result, record) directly.
  return { pixels: out, record, identifier: ident, contentHash: content_hash, width, height };
}
