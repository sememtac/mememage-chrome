// mememage — pure PNG decode for the Node input path. Zero dependencies:
// inflate comes from node:zlib (stdlib), everything else is the PNG spec.
//
// Node-only by design and only loaded dynamically (loadPixels routes here when
// given a file path / raw PNG bytes in Node). Browsers never reach this module —
// there, bytes/Blobs go through the platform's own decoders (createImageBitmap),
// which also cover JPEG/WebP. Node JPEG is deliberately NOT here: a pipeline
// that touches JPEGs already holds a decoder (e.g. sharp — pass us its raw RGBA)
// or can convert to PNG first; see loadPixels' error message.
//
// Scope: 8-bit-depth PNGs, color types 0 (gray), 2 (RGB), 3 (palette),
// 4 (gray+alpha), 6 (RGBA), non-interlaced, with palette tRNS. That covers
// every minted original (encode writes 8-bit RGB) and what common converters
// (sips, ImageMagick, Pillow) emit. 16-bit / interlaced / low-bit-depth PNGs
// error with a clear re-save hint rather than mis-decoding.
//
// Output is a flat RGBA Uint8ClampedArray — the codec's native input.

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// CRC-32 (PNG chunk checksums) — small table-driven implementation.
const _CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function _crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = _CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function _deflate(bytes) {
  // Node: stdlib zlib. Browser: CompressionStream("deflate") (zlib format).
  if (typeof process !== "undefined" && process.versions && process.versions.node
      && typeof document === "undefined") {
    const zlib = await import("node:zlib");
    return new Uint8Array(zlib.deflateSync(bytes));
  }
  if (typeof CompressionStream !== "undefined") {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error("no deflate available (need Node or a browser with CompressionStream)");
}

export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return false;
  return true;
}

export function isJpeg(bytes) {
  return !!bytes && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function u32(b, o) { return (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0; }

/**
 * Encode flat RGBA pixels as PNG file bytes — the write-side complement of
 * decodePng, closing the loop for encode() consumers ("returns raw RGBA you
 * must encode yourself" was the gap). 8-bit RGB output (color type 2, alpha
 * dropped — the bar writer's output is opaque, matching the Python core's RGB
 * PNGs), filter 0, zlib-deflated. Any PNG reader (Pillow included) opens it.
 * Accepts (pixels, width, height) or the loadPixels object form.
 * @returns {Promise<Uint8Array>} PNG file bytes
 */
export async function toPngBytes(pixels, width, height) {
  if (pixels && typeof pixels === "object" && !ArrayBuffer.isView(pixels)
      && (pixels.pixels || pixels.data) && Number.isInteger(pixels.width)) {
    const s = pixels; height = s.height; width = s.width; pixels = s.pixels || s.data;
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("toPngBytes needs integer width/height (or the loadPixels object form)");
  }
  // Raw scanlines: filter byte 0 + RGB triplets.
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;   // filter: None
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = row + 1 + x * 3;
      raw[d] = pixels[s]; raw[d + 1] = pixels[s + 1]; raw[d + 2] = pixels[s + 2];
    }
  }
  const idat = await _deflate(raw);

  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, _crc32(out.subarray(4, 8 + data.length)));
    return out;
  }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 2;   // 8-bit, RGB; compression/filter/interlace = 0
  const parts = [new Uint8Array(SIG), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  { let p = 0; for (const part of parts) { out.set(part, p); p += part.length; } }
  return out;
}

export async function decodePng(bytes) {
  if (!isPng(bytes)) throw new Error("not a PNG (bad signature)");
  const zlib = await import("node:zlib");

  // ---- chunk walk ---------------------------------------------------------
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = u32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = u32(data, 0); h = u32(data, 4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;   // len + type(4) + data + crc(4)
  }
  if (!w || !h) throw new Error("invalid PNG: no IHDR");
  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8-bit supported) — re-save as a standard 8-bit PNG`);
  }
  if (interlace !== 0) {
    throw new Error("unsupported interlaced (Adam7) PNG — re-save without interlacing");
  }
  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const ch = CHANNELS[colorType];
  if (!ch) throw new Error(`unsupported PNG color type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error("invalid PNG: palette image with no PLTE");

  // ---- inflate + unfilter -------------------------------------------------
  const total = idat.reduce((n, c) => n + c.length, 0);
  const compressed = new Uint8Array(total);
  { let p = 0; for (const c of idat) { compressed.set(c, p); p += c.length; } }
  const raw = zlib.inflateSync(compressed);

  const stride = w * ch;
  if (raw.length < (stride + 1) * h) throw new Error("invalid PNG: truncated image data");
  const img = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = (y * (stride + 1)) + 1;
    const rowOut = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rowIn + x];
      const left = x >= ch ? img[rowOut + x - ch] : 0;
      const up = y > 0 ? img[rowOut - stride + x] : 0;
      const ul = (y > 0 && x >= ch) ? img[rowOut - stride + x - ch] : 0;
      let v;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + left; break;
        case 2: v = cur + up; break;
        case 3: v = cur + ((left + up) >> 1); break;
        case 4: {                                     // Paeth
          const p = left + up - ul;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
          v = cur + (pa <= pb && pa <= pc ? left : (pb <= pc ? up : ul));
          break;
        }
        default: throw new Error(`invalid PNG: unknown filter ${filter}`);
      }
      img[rowOut + x] = v & 0xff;
    }
  }

  // ---- to flat RGBA -------------------------------------------------------
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * ch, d = i * 4;
    switch (colorType) {
      case 0:   // grayscale
        out[d] = out[d + 1] = out[d + 2] = img[s]; out[d + 3] = 255; break;
      case 2:   // RGB
        out[d] = img[s]; out[d + 1] = img[s + 1]; out[d + 2] = img[s + 2]; out[d + 3] = 255; break;
      case 3: { // palette (+ optional tRNS alpha)
        const p = img[s] * 3;
        out[d] = palette[p]; out[d + 1] = palette[p + 1]; out[d + 2] = palette[p + 2];
        out[d + 3] = trns && img[s] < trns.length ? trns[img[s]] : 255; break;
      }
      case 4:   // gray + alpha
        out[d] = out[d + 1] = out[d + 2] = img[s]; out[d + 3] = img[s + 1]; break;
      case 6:   // RGBA
        out[d] = img[s]; out[d + 1] = img[s + 1]; out[d + 2] = img[s + 2]; out[d + 3] = img[s + 3]; break;
    }
  }
  return { pixels: out, width: w, height: h };
}
