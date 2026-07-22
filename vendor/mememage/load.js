// mememage — input adapter: turn any reasonable image source into the flat
// RGBA {pixels, width, height} the codec eats. Mirrors the SPIRIT of the Python
// core's flexible inputs (path / bytes / file-like / PIL image), adapted to
// each JS environment's physics:
//
//   anywhere  {pixels|data, width, height}    already-raw pixels (sharp .raw(),
//                                             a prior loadPixels, ImageData, …)
//   browser   ImageData | canvas | <img> | ImageBitmap | Blob/File | bytes
//             — decoded by the PLATFORM (createImageBitmap), so JPEG/WebP/HEIC
//             ride the browser's own decoders, zero dependencies
//   Node      file path (string) | Buffer/Uint8Array of PNG or JPEG file bytes
//             — PNG via the pure decoder (node:zlib, always); JPEG via the
//             OPTIONAL jpeg-js peer (`npm install jpeg-js` — lazy-imported, so
//             the default install stays zero-dependency). No jpeg-js and no
//             conversion? Pass raw pixels from your image library instead
//             (e.g. sharp(file).raw()).
//
// NO network, ever: a string is a filesystem path (Node), never a URL — the SDK
// does not fetch. Async because platform decoders are async.

/** Is this a raw-pixels source object ({pixels|data, width, height} — e.g. the
 * result of loadPixels, or an ImageData)? Shared by decode/verify/encode so the
 * object form works uniformly across the whole API. */
export function isRawSource(v) {
  return !!v && typeof v === "object" && !ArrayBuffer.isView(v)
    && !!(v.pixels || v.data) && Number.isInteger(v.width) && Number.isInteger(v.height);
}

const NODE_JPEG_HINT =
  "JPEG in Node needs the optional jpeg-js package: `npm install jpeg-js` " +
  "(declared as an optional peer — the default install stays zero-dependency). " +
  "Alternatives: pass raw pixels from your image library (e.g. " +
  "sharp(file).raw().toBuffer() + metadata for width/height), or convert to PNG " +
  "first (macOS: `sips -s format png in.jpg --out out.png`; ImageMagick: " +
  "`magick in.jpg out.png`). In the browser this decodes natively.";

async function _decodeJpegNode(bytes) {
  // Opt-in JPEG via the optional jpeg-js peer (pure JS, MIT). Lazy import so a
  // default zero-dep install never loads or needs it — the npm analog of
  // Python's `pip install mememage[heic]` extras. NOTE: JPEG decoding is not
  // bit-exact across implementations (spec-tolerated IDCT variance), so bar
  // recovery from a JPEG rides the codec's noise margin — the same guarantee
  // the browser path (platform decoders) lives under.
  let m;
  try {
    m = await import("jpeg-js");
  } catch (e) {
    throw new Error(NODE_JPEG_HINT);
  }
  const dec = m.decode || (m.default && m.default.decode);
  let out;
  try {
    out = dec(bytes, { useTArray: true, formatAsRGBA: true });
  } catch (e) {
    throw new Error("invalid or corrupt JPEG: " + (e && e.message ? e.message : e));
  }
  return {
    pixels: new Uint8ClampedArray(out.data.buffer, out.data.byteOffset, out.data.byteLength),
    width: out.width, height: out.height,
  };
}

function _isNode() {
  return typeof process !== "undefined" && !!process.versions && !!process.versions.node
    && typeof document === "undefined";
}

function _normRaw(obj) {
  const pixels = obj.pixels || obj.data;
  const { width, height } = obj;
  if (!pixels || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error("raw pixel source needs {pixels|data, width, height}");
  }
  if (pixels.length < width * height * 4) {
    throw new Error(`pixel buffer too small: ${pixels.length} bytes for ${width}x${height} RGBA`);
  }
  return { pixels, width, height };
}

async function _fromDrawable(drawable, w, h) {
  // Draw onto a canvas to reach getImageData — the browser's universal
  // decoded-pixels tap. OffscreenCanvas where available, DOM canvas otherwise.
  let canvas;
  if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(w, h);
  else if (typeof document !== "undefined") {
    canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  } else throw new Error("no canvas available to rasterize this source");
  const ctx = canvas.getContext("2d");
  ctx.drawImage(drawable, 0, 0);
  const d = ctx.getImageData(0, 0, w, h);
  return { pixels: d.data, width: d.width, height: d.height };
}

async function _fromBytes(bytes) {
  const { isPng, isJpeg, decodePng } = await import("./png.js");
  if (_isNode()) {
    if (isPng(bytes)) return decodePng(bytes);
    if (isJpeg(bytes)) return _decodeJpegNode(bytes);
    throw new Error("unrecognized image bytes (not PNG or JPEG) — " + NODE_JPEG_HINT);
  }
  // Browser: let the platform decode any format it knows (PNG/JPEG/WebP/…).
  const blob = new Blob([bytes]);
  const bmp = await createImageBitmap(blob);
  try { return await _fromDrawable(bmp, bmp.width, bmp.height); }
  finally { if (bmp.close) bmp.close(); }
}

/**
 * Normalize any supported image source to { pixels, width, height } (flat RGBA).
 * See the module header for what each environment accepts. Never fetches.
 * @returns {Promise<{pixels: Uint8ClampedArray, width: number, height: number}>}
 */
export async function loadPixels(source) {
  if (source == null) throw new Error("loadPixels: no source given");

  // Already-raw pixels (ImageData matches this shape too).
  if (typeof source === "object" && !ArrayBuffer.isView(source)
      && !(source instanceof ArrayBuffer)
      && (source.pixels || source.data) && !(typeof Blob !== "undefined" && source instanceof Blob)) {
    // Canvas-like objects also have width/height but no .data — handled below.
    if (source.pixels || (source.data && Number.isInteger(source.width))) return _normRaw(source);
  }

  // Canvas (has getContext) → read its pixels directly.
  if (typeof source === "object" && typeof source.getContext === "function") {
    const d = source.getContext("2d").getImageData(0, 0, source.width, source.height);
    return { pixels: d.data, width: d.width, height: d.height };
  }

  // Drawables: ImageBitmap / HTMLImageElement (browser).
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    return _fromDrawable(source, source.width, source.height);
  }
  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) {
    const w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
    return _fromDrawable(source, w, h);
  }

  // Blob / File — bytes with a platform decode in the browser.
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    if (!_isNode() && typeof createImageBitmap !== "undefined") {
      const bmp = await createImageBitmap(source);
      try { return await _fromDrawable(bmp, bmp.width, bmp.height); }
      finally { if (bmp.close) bmp.close(); }
    }
    return _fromBytes(new Uint8Array(await source.arrayBuffer()));
  }

  // Raw file bytes (an ENCODED image file, not pixels — pixels come with
  // width/height via the object form above).
  if (source instanceof ArrayBuffer) return _fromBytes(new Uint8Array(source));
  if (ArrayBuffer.isView(source)) {
    return _fromBytes(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  }

  // A string is a FILESYSTEM PATH (Node only). Never a URL — core doesn't fetch.
  if (typeof source === "string") {
    if (!_isNode()) {
      throw new Error("string sources are filesystem paths (Node only) — in the " +
                      "browser pass a File/Blob, ImageData, canvas, or <img> instead " +
                      "(the SDK never fetches URLs)");
    }
    const fs = await import("node:fs");
    return _fromBytes(fs.readFileSync(source));
  }

  throw new Error("unsupported image source: " + Object.prototype.toString.call(source));
}
