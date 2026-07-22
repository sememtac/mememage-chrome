// mememage — field encryption. Mirrors mememage/crypto.py + api.py:unlock/is_encrypted.
//
// AES-256-GCM under a key derived by PBKDF2-HMAC-SHA256 (600k iterations). The envelope
// is {salt, iv, ct, tag}, all hex, byte-compatible with Python — a record encrypted here
// unlocks in Python and vice versa. Uses SubtleCrypto (browser `crypto`, Node 20+
// `globalThis.crypto`), which does every primitive natively.

const _PBKDF2_ITERATIONS = 600000;   // OWASP 2024, must match crypto.py

function _hex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}
function _fromHex(h) {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
}

async function _deriveKey(password, salt) {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: _PBKDF2_ITERATIONS, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM encrypt a string → {salt, iv, ct, tag} (hex). Mirrors crypto.py:encrypt_field. */
export async function encryptField(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await _deriveKey(password, salt);
  // SubtleCrypto appends the 16-byte GCM tag to the ciphertext, same as Python.
  const ctTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  return {
    salt: _hex(salt), iv: _hex(iv),
    ct: _hex(ctTag.slice(0, -16)), tag: _hex(ctTag.slice(-16)),
  };
}

/** Decrypt a {salt, iv, ct, tag} envelope → plaintext. Throws on wrong password. */
export async function decryptField(envelope, password) {
  const salt = _fromHex(envelope.salt), iv = _fromHex(envelope.iv);
  const ct = _fromHex(envelope.ct), tag = _fromHex(envelope.tag);
  const key = await _deriveKey(password, salt);
  const ctTag = new Uint8Array(ct.length + tag.length);
  ctTag.set(ct); ctTag.set(tag, ct.length);
  let pt;
  try {
    pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ctTag);
  } catch (e) {
    throw new Error("Wrong password — decryption failed");
  }
  return new TextDecoder().decode(pt);
}

/** True if a record carries an encrypted_fields envelope. Mirrors api.py:is_encrypted. */
export function isEncrypted(record) {
  return !!(record && record.encrypted_fields);
}

/**
 * Decrypt an encrypted record's private fields → the readable view (public fields +
 * decrypted private, encrypted_fields dropped). Mirrors api.py:unlock. This is the
 * readable view for DISPLAY — its hash is over the ciphertext, so don't re-hash it.
 * A record with no encrypted_fields is returned unchanged. Throws on the wrong password.
 */
export async function unlock(record, password) {
  const env = record && record.encrypted_fields;
  if (!env) return { ...record };
  const priv = JSON.parse(await decryptField(env, password));
  const view = {};
  for (const k of Object.keys(record)) if (k !== "encrypted_fields") view[k] = record[k];
  return { ...view, ...priv };
}
