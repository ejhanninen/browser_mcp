/* Bidirectional substitution cipher between the page and the AI.
 *
 * - redact(text): replaces each registered "original" with a stable opaque
 *   token. Substring-level, longest-match-first, case-PRESERVING — each
 *   distinct casing of a keyword gets its own token so identifiers stay
 *   distinct (acmeSend vs AcmeSend become different tokens).
 * - unredact(text): inverse, for AI-controlled strings that hit the page
 *   (eval expressions). Symmetric replace.
 *
 * Tokens are tok_ + 6 hex chars, all the same length, fixed prefix — so no
 * token can be a substring of another and reversal is unambiguous.
 *
 * The table grows monotonically within an attach session: keywords seed the
 * common casings, real source/responses get scanned for new casings before
 * redaction, and origins discovered via CDP events get registered too.
 */

const STRIP_HEADERS =
  /^(server|via|x-powered-by|referer|origin|host|x-served-by|x-amz-cf-pop|cf-ray|x-vercel-id|x-github-request-id|x-request-id|x-trace-id|x-debug-token|report-to|nel|alt-svc|x-frame-options-source)$/i;

export class Redactor {
  constructor() {
    this.byOriginal = new Map(); // original -> token
    this.byToken = new Map(); // token -> original
    this.entries = []; // [{original, token}] sorted by original.length desc
    this.bases = new Set(); // lowercased base keywords; scanned for new casings
  }

  reset() {
    this.byOriginal.clear();
    this.byToken.clear();
    this.entries.length = 0;
    this.bases.clear();
  }

  stats() {
    return { entries: this.entries.length, bases: this.bases.size };
  }

  _newToken() {
    let t;
    do {
      const buf = new Uint8Array(3);
      crypto.getRandomValues(buf);
      t =
        "tok_" +
        Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
    } while (this.byToken.has(t));
    return t;
  }

  _register(original) {
    if (!original) return null;
    const existing = this.byOriginal.get(original);
    if (existing) return existing;
    const token = this._newToken();
    this.byOriginal.set(original, token);
    this.byToken.set(token, original);
    this.entries.push({ original, token });
    // longest-match-first on outbound
    this.entries.sort((a, b) => b.original.length - a.original.length);
    return token;
  }

  addKeyword(word) {
    const w = (word || "").trim();
    if (!w) return;
    this.bases.add(w.toLowerCase());
    // pre-seed common casings so first appearance is already covered
    const variants = new Set([
      w,
      w.toLowerCase(),
      w.toUpperCase(),
      w[0].toUpperCase() + w.slice(1).toLowerCase(),
    ]);
    for (const v of variants) this._register(v);
  }

  setKeywords(words) {
    this.reset();
    for (const w of words || []) this.addKeyword(w);
  }

  addOrigin(urlOrHost) {
    if (!urlOrHost) return;
    let host = urlOrHost;
    try {
      if (urlOrHost.includes("://")) host = new URL(urlOrHost).hostname;
    } catch {}
    if (!host || host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host))
      return;
    // register the full hostname so URL substitution catches it verbatim
    this._register(host);
    this.bases.add(host.toLowerCase());
    // eTLD+1 root word ("acme" from "acme.com" / "www.acme.co.uk") drives
    // brand-token redaction beyond just URL strings
    const parts = host.toLowerCase().split(".").filter(Boolean);
    if (parts.length >= 2) {
      const root = parts[parts.length - 2];
      if (root && root.length >= 3 && !/^(www|com|net|org|io|co)$/.test(root)) {
        this.addKeyword(root);
      }
    }
  }

  // Before redacting, scan the text for any casing of a known base keyword we
  // haven't seen yet, and register it. This is how "AcMe" gets a token even
  // though only "acme" was configured.
  _discoverCasings(text) {
    if (!text || !this.bases.size) return;
    for (const base of this.bases) {
      const re = new RegExp(
        base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "gi"
      );
      let m;
      while ((m = re.exec(text)) !== null) {
        const occ = m[0];
        if (!this.byOriginal.has(occ)) this._register(occ);
      }
    }
  }

  redact(text) {
    if (typeof text !== "string" || !text) return text;
    this._discoverCasings(text);
    let out = text;
    for (const { original, token } of this.entries) {
      if (out.indexOf(original) !== -1) out = out.split(original).join(token);
    }
    return out;
  }

  unredact(text) {
    if (typeof text !== "string" || !text) return text;
    let out = text;
    // all tokens are the same length, so iteration order doesn't matter
    for (const [token, original] of this.byToken) {
      if (out.indexOf(token) !== -1) out = out.split(token).join(original);
    }
    return out;
  }

  // Walk an arbitrary JSON-ish value and redact string leaves in place.
  redactValue(v) {
    if (typeof v === "string") return this.redact(v);
    if (v == null) return v;
    if (Array.isArray(v)) return v.map((x) => this.redactValue(x));
    if (typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = this.redactValue(val);
      return out;
    }
    return v;
  }

  sanitizeHeaders(headers) {
    if (!headers) return headers;
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
      if (STRIP_HEADERS.test(k)) continue;
      let val = String(v);
      // Set-Cookie domain attr leaks the host even if the cookie value is fine
      if (/^set-cookie$/i.test(k))
        val = val.replace(/;\s*Domain=[^;]+/gi, "");
      out[k] = this.redact(val);
    }
    return out;
  }
}
