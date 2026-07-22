// mememage — content-hash verification (the WITNESSED check). Mirrors
// mememage/hashing.py.
//
// Pure math, NO network, NO storage — like the Python core, this module never
// fetches. Signature/keychain/portrait checks (AUTHENTICATED / EMBODIED) are
// reference-implementation concerns and are deliberately not in the SDK; they
// live in the canonical chain's decoder site.

// ----- Content hash computation -----
//
// The core library implements ONLY the "open" hash model — the raw / adoption hash
// version, the one the raw API and ComfyUI produce. "open" INVERTS the curated rule:
// hash EVERY field except the structurally-circular pair below and any `_`-prefixed
// key (decoder-internal keys stamped onto a fetched record, e.g. `_source`; excluding
// them keeps the hash stable). Schema-agnostic — it verifies whatever fields a record
// carries, so it needs no knowledge of any particular chain's schema.
//
// Curated integer versions (hash_version 1, …) are the canonical chain's inclusion
// sets — a reference-implementation concern, not the core — so a record on such a
// version reads as UNSUPPORTED here, NOT tampered. Mirrors core.py
// is_supported_hash_version + the ComfyUI/decoder UNSUPPORTED verdict: an app-defined
// hash model is not tamper evidence; its integrity is verified in that app's decoder.
const OPEN_HASH_VERSION = 'open';
const HASH_EXCLUDED_OPEN = new Set(['content_hash', 'signature']);

function isSupportedHashVersion(record) {
  return !!record && record.hash_version === OPEN_HASH_VERSION;
}

// The subset of `record` the content hash covers. Caller guarantees the record is on a
// supported (open) version; hash everything except the circular pair and `_`-prefixed
// decoder-internal keys. Mirrors core.py _hashable_fields (open path).
function _hashableFields(record) {
  var hashable = {};
  Object.keys(record)
    .filter(function(k) { return !HASH_EXCLUDED_OPEN.has(k) && k.charAt(0) !== '_'; })
    .sort()
    .forEach(function(k) { hashable[k] = record[k]; });
  return hashable;
}

function sortKeysDeep(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj !== null && typeof obj === 'object') {
    const sorted = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = sortKeysDeep(obj[k]);
    return sorted;
  }
  return obj;
}

// Pure-JS SHA-256 fallback for environments where crypto.subtle is
// unavailable. iOS Safari and most browsers gate crypto.subtle to
// "secure contexts" — HTTPS with a publicly-trusted cert, or
// http://localhost. A VPS reached over a self-signed
// cert doesn't qualify (Safari treats user-trusted self-signed
// certs as insecure for API-gating purposes), so crypto.subtle is
// undefined there. This fallback keeps the codec working in any
// context: file://, self-signed HTTPS, plain HTTP, etc.
//
// ~60 lines of FIPS 180-4 SHA-256. Returns Uint8Array of 32 bytes.
var _SHA256_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
function _sha256_js(bytes) {
  // bytes: Uint8Array
  var H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  var bitLen = bytes.length * 8;
  // Padding: append 0x80, then zeros, then 8-byte big-endian length.
  var padLen = (bytes.length + 9 + 63) & ~63;
  var padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // 64-bit length BE — for our use case lengths fit in 32 bits.
  padded[padLen - 4] = (bitLen >>> 24) & 0xff;
  padded[padLen - 3] = (bitLen >>> 16) & 0xff;
  padded[padLen - 2] = (bitLen >>> 8)  & 0xff;
  padded[padLen - 1] = bitLen & 0xff;
  var W = new Uint32Array(64);
  for (var block = 0; block < padLen; block += 64) {
    for (var i = 0; i < 16; i++) {
      W[i] = (padded[block + i*4] << 24) | (padded[block + i*4 + 1] << 16) | (padded[block + i*4 + 2] << 8) | padded[block + i*4 + 3];
    }
    for (var i = 16; i < 64; i++) {
      var s0 = ((W[i-15] >>> 7) | (W[i-15] << 25)) ^ ((W[i-15] >>> 18) | (W[i-15] << 14)) ^ (W[i-15] >>> 3);
      var s1 = ((W[i-2] >>> 17) | (W[i-2] << 15)) ^ ((W[i-2] >>> 19) | (W[i-2] << 13)) ^ (W[i-2] >>> 10);
      W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (var i = 0; i < 64; i++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + _SHA256_K[i] + W[i]) >>> 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var mj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]+a)>>>0; H[1] = (H[1]+b)>>>0; H[2] = (H[2]+c)>>>0; H[3] = (H[3]+d)>>>0;
    H[4] = (H[4]+e)>>>0; H[5] = (H[5]+f)>>>0; H[6] = (H[6]+g)>>>0; H[7] = (H[7]+h)>>>0;
  }
  var out = new Uint8Array(32);
  for (var i = 0; i < 8; i++) {
    out[i*4]     = (H[i] >>> 24) & 0xff;
    out[i*4 + 1] = (H[i] >>> 16) & 0xff;
    out[i*4 + 2] = (H[i] >>> 8)  & 0xff;
    out[i*4 + 3] = H[i] & 0xff;
  }
  return out;
}

// Cross-context SHA-256: use crypto.subtle when available (much
// faster, hardware-accelerated on most platforms), fall back to the
// pure-JS implementation when it isn't (self-signed HTTPS on iOS
// Safari, file://, etc.).
async function _sha256_bytes(input) {
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    try {
      var buf = await crypto.subtle.digest('SHA-256', input);
      return new Uint8Array(buf);
    } catch (e) {
      // Fall through to JS fallback on any SubtleCrypto failure.
    }
  }
  return _sha256_js(input);
}

async function sha256_16(obj) {
  var sorted = sortKeysDeep(obj);
  var noSpaces = JSON.stringify(sorted).replace(/[\u0080-\uffff]/g, function(c) {
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  });
  var encoded = new TextEncoder().encode(noSpaces);
  var hash = await _sha256_bytes(encoded);
  var hashArr = Array.from(hash);
  return hashArr.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('').slice(0, 16);
}

async function computeContentHash(record) {
  if (!isSupportedHashVersion(record)) return null;   // UNSUPPORTED — not tampering
  try {
    return await sha256_16(_hashableFields(record));
  } catch (e) {
    return null;
  }
}


export { computeContentHash, isSupportedHashVersion, sha256_16, sortKeysDeep, OPEN_HASH_VERSION };
