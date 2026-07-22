// Bar geometry + asym-camo constants the decoder depends on. Values are verbatim
// from docs/js/data.js (and match the set the Python↔JS parity harness injects),
// so the shared library stays byte-compatible with the frozen decoder and the core.
export const SIG_ROWS = 2, HEADER_BAND = 8, HEADER_PIXELS = 24, FOOTER_PIXELS = 24,
  PIXELS_PER_BIT = 3, PIXELS_PER_BIT_NARROW = 2, PIXELS_PER_BIT_MAX = 6,
  BAR_DELTA = 64, LOCAL_CONTEXT_ROWS = 6, RS_NSYM = 6, RGB_THRESHOLD = 128,
  ASYM_ENCODE = true, ASYM_DELTA = 40, ASYM_FLOOR = 50, ASYM_BOX_RADIUS = 34,
  ASYM_SCALE_CAP = 2.0,
  EVENFILL_MIN_BYTES = 33, EVENFILL_MAX_BYTES = 64;
