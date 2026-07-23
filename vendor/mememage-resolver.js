// mememage-resolver — resolve a Mememage identifier to a record over configured
// mirrors, then check its integrity. The network layer, framework-agnostic.
//
// A Mememage bar carries an identifier + a content hash. The identifier is a lookup key,
// NOT an authority: the resolver walks an ordered list of record sources (mirrors), and
// the FIRST source that has the record wins. The source is never trusted — the content
// hash in the bar's pixels is the authority, so a mirror can only fail to verify, never
// forge. This module owns the mirror walk, the per-source timeout, and the fallback.
//
// It is I/O-injected. You provide:
//   • fetch(url, init)      — the HTTP fetch (privileged in an extension; window.fetch on a page).
//   • verifyMath            — { computeContentHash, isSupportedHashVersion } from the `mememage` SDK.
//   • sources               — the ordered mirror list (array, or a function returning one — dynamic).
//   • timeout               — per-source timeout ms (number, or a function returning one).
//
//   createResolver({ fetch, verifyMath, sources, timeout }) ->
//     { resolveRecord(id, opts), fetchRecord(id, opts), verify(bar, opts) }
//
// A mirror base is a URL template. `{id}` is substituted with the identifier; otherwise
// the identifier is appended. The resolver tries `<base>/<id>.json` then `<id>.soul`.

const DEFAULT_TIMEOUT_MS = 5000;

export function createResolver(deps) {
  "use strict";
  deps = deps || {};
  const _fetch = deps.fetch;
  if (typeof _fetch !== "function") {
    throw new TypeError("createResolver: options.fetch (url, init) => Promise<Response> is required");
  }
  const vm = deps.verifyMath || {};
  const _computeContentHash = vm.computeContentHash;
  const _isSupportedHashVersion = vm.isSupportedHashVersion;
  const _sources = deps.sources != null ? deps.sources : [];
  const _timeout = deps.timeout != null ? deps.timeout : DEFAULT_TIMEOUT_MS;

  // sources / timeout accept a value OR a (possibly async) function, so a consumer can
  // back them with live config (the extension reads chrome.storage fresh each call).
  async function settle(v, fallback) {
    try { return (typeof v === "function") ? await v() : await v; }
    catch (e) { return fallback; }
  }
  async function getSources(opts) {
    const raw = (opts && opts.sources != null) ? opts.sources : _sources;
    const s = await settle(raw, []);
    return Array.isArray(s) ? s.filter(Boolean) : [];
  }
  async function getTimeout(opts) {
    const raw = (opts && opts.timeout != null) ? opts.timeout : _timeout;
    const n = Number(await settle(raw, DEFAULT_TIMEOUT_MS));
    return isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
  }

  function expandBase(base, identifier) {
    return String(base).replace(/\{id\}/g, identifier).replace(/\/+$/, "");
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
        resp = await _fetch(url, { credentials: "omit", signal: AbortSignal.timeout(ms) });
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
  async function resolveRecord(identifier, opts) {
    const sources = await getSources(opts);
    if (!sources.length) return { noSource: true };
    const ms = await getTimeout(opts);
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

  // One-line summary of a total-failure resolveRecord result, for a card / log.
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

  // Resolve a record by identifier — the "fetch record" command. Returns the URL that
  // answered so a UI can link to it. { ok, url, source } | { noSource } | { notFound, detail }.
  async function fetchRecord(identifier, opts) {
    const res = await resolveRecord(identifier, opts);
    if (res.noSource) return { noSource: true };
    if (res.record) return { ok: true, url: res.url, source: res.source };
    return { notFound: true, detail: triedSummary(res) };
  }

  // Verify a SPECIFIC bar (identifier + the hash stamped in its pixels). Works for any
  // bar, not just the bottom one: fetch the record, recompute its content hash, compare
  // to the bar's. No pixel re-decode — the bar's hash is authoritative and already in
  // hand. Returns a verdict:
  //   { state: "verified" | "altered" | "norecord" | "error" | "nosource" | "unsupported", ... }
  async function verify(bar, opts) {
    const identifier = bar && bar.identifier, contentHash = bar && bar.contentHash;
    const base = { identifier: identifier, contentHash: contentHash };
    const res = await resolveRecord(identifier, opts);
    if (res.noSource) return { state: "nosource", ...base };
    if (!res.record) {
      // A blocked source is a fetch failure (error), not an absence (norecord).
      const summary = triedSummary(res);
      return res.anyBlocked ? { state: "error", ...base, reason: summary }
                            : { state: "norecord", ...base, detail: summary };
    }

    const record = res.record, recordUrl = res.url, srcBase = res.source;
    if (_isSupportedHashVersion && !_isSupportedHashVersion(record)) {
      return { state: "unsupported", ...base, source: srcBase, recordUrl: recordUrl,
               detail: "The record uses hash model " + JSON.stringify(record && record.hash_version) +
                       ". This check covers the open model only, so it cannot confirm this record's " +
                       "integrity here. This is not tampering." };
    }
    if (typeof _computeContentHash !== "function") {
      throw new Error("createResolver: verifyMath.computeContentHash is required to verify()");
    }
    const recomputed = await _computeContentHash(record);
    if (recomputed !== contentHash) {
      return { state: "altered", ...base, source: srcBase, recordUrl: recordUrl,
               detail: "Hash mismatch. The bar has " + contentHash + ". The record computes to " + recomputed + "." };
    }
    return { state: "verified", ...base, source: srcBase, recordUrl: recordUrl };
  }

  return {
    resolveRecord: resolveRecord,   // (id, opts) -> { record, url, source } | { noSource } | { notFound, ... }
    fetchRecord: fetchRecord,       // (id, opts) -> { ok, url, source } | { noSource } | { notFound, detail }
    verify: verify,                 // (bar, opts) -> verdict
  };
}

export default createResolver;
