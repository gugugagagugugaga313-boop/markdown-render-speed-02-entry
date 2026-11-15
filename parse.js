// parse.js — a fast Markdown renderer that returns exactly the HTML marked
// 18.1.3 produces with its default options (GFM enabled), byte for byte.
// Written from scratch: a line-based block parser plus a single-pass inline
// scanner with a delimiter-stack emphasis pass. No dependencies, no state
// shared between calls.

// ---------------------------------------------------------------------------
// Character tables
// ---------------------------------------------------------------------------

const PUNCT_ASCII = new Uint8Array(128);
for (let i = 33; i <= 47; i++) PUNCT_ASCII[i] = 1;
for (let i = 58; i <= 64; i++) PUNCT_ASCII[i] = 1;
for (let i = 91; i <= 96; i++) PUNCT_ASCII[i] = 1;
for (let i = 123; i <= 126; i++) PUNCT_ASCII[i] = 1;

const WORD_ASCII = new Uint8Array(128);
for (let i = 48; i <= 57; i++) WORD_ASCII[i] = 1;
for (let i = 65; i <= 90; i++) WORD_ASCII[i] = 1;
for (let i = 97; i <= 122; i++) WORD_ASCII[i] = 1;
WORD_ASCII[95] = 1;

const ALNUM_ASCII = new Uint8Array(128);
for (let i = 48; i <= 57; i++) ALNUM_ASCII[i] = 1;
for (let i = 65; i <= 90; i++) ALNUM_ASCII[i] = 1;
for (let i = 97; i <= 122; i++) ALNUM_ASCII[i] = 1;

const LOCAL_ASCII = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-") LOCAL_ASCII[ch.charCodeAt(0)] = 1;

const DOMAIN_ASCII = new Uint8Array(128);
for (let i = 48; i <= 57; i++) DOMAIN_ASCII[i] = 1;
for (let i = 65; i <= 90; i++) DOMAIN_ASCII[i] = 1;
for (let i = 97; i <= 122; i++) DOMAIN_ASCII[i] = 1;
DOMAIN_ASCII[95] = 1;
DOMAIN_ASCII[45] = 1;
DOMAIN_ASCII[46] = 1;

const LABEL_ASCII = new Uint8Array(128);
for (let i = 48; i <= 57; i++) LABEL_ASCII[i] = 1;
for (let i = 65; i <= 90; i++) LABEL_ASCII[i] = 1;
for (let i = 97; i <= 122; i++) LABEL_ASCII[i] = 1;
LABEL_ASCII[45] = 1;

const SCHEME_ASCII = new Uint8Array(128);
for (let i = 48; i <= 57; i++) SCHEME_ASCII[i] = 1;
for (let i = 65; i <= 90; i++) SCHEME_ASCII[i] = 1;
for (let i = 97; i <= 122; i++) SCHEME_ASCII[i] = 1;
SCHEME_ASCII[43] = 1;
SCHEME_ASCII[45] = 1;
SCHEME_ASCII[46] = 1;

const TAGNAME_ASCII = new Uint8Array(128);
for (let i = 48; i <= 57; i++) TAGNAME_ASCII[i] = 1;
for (let i = 65; i <= 90; i++) TAGNAME_ASCII[i] = 1;
for (let i = 97; i <= 122; i++) TAGNAME_ASCII[i] = 1;
TAGNAME_ASCII[45] = 1;

const HEX2 = new Array(256);
for (let i = 0; i < 256; i++) HEX2[i] = i.toString(16).toUpperCase().padStart(2, "0");

const URL_KEEP = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789;,/?:@&=+$_.!~*'()#-%") URL_KEEP[ch.charCodeAt(0)] = 1;

// ---------------------------------------------------------------------------
// Escaping and URLs
// ---------------------------------------------------------------------------

const ESC_RE = /[&<>"']/;
function escapeText(s) {
  if (!ESC_RE.test(s)) return s;
  let out = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep;
    if (c === 38) rep = "&amp;";
    else if (c === 60) rep = "&lt;";
    else if (c === 62) rep = "&gt;";
    else if (c === 34) rep = "&quot;";
    else if (c === 39) rep = "&#39;";
    else continue;
    if (out === null) out = [];
    out.push(s.slice(start, i), rep);
    start = i + 1;
  }
  if (out === null) return s;
  out.push(s.slice(start));
  return out.join("");
}

// Index just past the ';' when s holds a valid entity pattern at i ('&'),
// otherwise -1. Named: &[A-Za-z0-9_]+;  Numeric: &#digits{1,7}; or &#[xX]hex{1,6};
function entityEnd(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j < n && s.charCodeAt(j) === 35) {
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      j++;
      const start = j;
      while (j < n) {
        const c = s.charCodeAt(j);
        if ((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)) j++;
        else break;
      }
      const len = j - start;
      if (len >= 1 && len <= 6 && j < n && s.charCodeAt(j) === 59) return j + 1;
      return -1;
    }
    const start = j;
    while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    const len = j - start;
    if (len >= 1 && len <= 7 && j < n && s.charCodeAt(j) === 59) return j + 1;
    return -1;
  }
  const start = j;
  while (j < n && s.charCodeAt(j) < 128 && WORD_ASCII[s.charCodeAt(j)]) j++;
  if (j > start && j < n && s.charCodeAt(j) === 59) return j + 1;
  return -1;
}

// Decode a numeric entity at s[i] ('&' followed by '#'). Returns
// {ch, end} or null when the pattern is not a valid numeric entity.
function decodeNumeric(s, i) {
  const n = s.length;
  let j = i + 2;
  let hex = false;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
    hex = true;
    j++;
  }
  const start = j;
  let v = 0;
  if (hex) {
    while (j < n) {
      const c = s.charCodeAt(j);
      let d = -1;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (c >= 97 && c <= 102) d = c - 87;
      else if (c >= 65 && c <= 70) d = c - 55;
      else break;
      v = v * 16 + d;
      j++;
      if (j - start > 6) return null;
    }
    if (j - start < 1) return null;
  } else {
    while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) {
      v = v * 10 + (s.charCodeAt(j) - 48);
      j++;
      if (j - start > 7) return null;
    }
    if (j - start < 1) return null;
  }
  if (j >= n || s.charCodeAt(j) !== 59) return null;
  let ch;
  if (v === 0 || (v >= 0xd800 && v <= 0xdfff) || v > 0x10ffff) ch = "\uFFFD";
  else ch = String.fromCodePoint(v);
  return { ch, end: j + 1 };
}

// Attribute escaping that preserves valid entity patterns verbatim.
function escapeAttrPreserve(s) {
  if (!ESC_RE.test(s)) return s;
  let out = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const e = entityEnd(s, i);
      if (e !== -1) {
        i = e - 1;
        continue;
      }
      if (out === null) out = [];
      out.push(s.slice(start, i), "&amp;");
      start = i + 1;
      continue;
    }
    let rep;
    if (c === 60) rep = "&lt;";
    else if (c === 62) rep = "&gt;";
    else if (c === 34) rep = "&quot;";
    else if (c === 39) rep = "&#39;";
    else continue;
    if (out === null) out = [];
    out.push(s.slice(start, i), rep);
    start = i + 1;
  }
  if (out === null) return s;
  out.push(s.slice(start));
  return out.join("");
}

// Percent-encode a URL the way marked's cleanUrl does: keep the usual
// unreserved and sub-delimiter characters plus '%', encode everything else,
// UTF-8 percent-encoding non-ASCII.
function cleanUrl(s) {
  let needs = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 128 || !URL_KEEP[c]) {
      needs = true;
      break;
    }
  }
  if (!needs) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128 && URL_KEEP[c]) {
      out += s[i];
      continue;
    }
    if (c < 128) {
      out += "%" + HEX2[c];
      continue;
    }
    let cp = c;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x800) {
      out += "%" + HEX2[0xc0 | (cp >> 6)] + "%" + HEX2[0x80 | (cp & 0x3f)];
    } else if (cp < 0x10000) {
      out += "%" + HEX2[0xe0 | (cp >> 12)] + "%" + HEX2[0x80 | ((cp >> 6) & 0x3f)] + "%" + HEX2[0x80 | (cp & 0x3f)];
    } else {
      out += "%" + HEX2[0xf0 | (cp >> 18)] + "%" + HEX2[0x80 | ((cp >> 12) & 0x3f)] + "%" + HEX2[0x80 | ((cp >> 6) & 0x3f)] + "%" + HEX2[0x80 | (cp & 0x3f)];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unicode flanking (CommonMark delimiter rules)
// ---------------------------------------------------------------------------

const RE_PUNCT = /\p{P}|\p{S}/u;
const RE_ZS = /\p{Zs}/u;
const punctCache = new Map();
const wsCache = new Map();

function isPunctCp(cp) {
  if (cp < 0) return false;
  if (cp < 128) return PUNCT_ASCII[cp] === 1;
  let v = punctCache.get(cp);
  if (v === undefined) {
    v = RE_PUNCT.test(String.fromCodePoint(cp));
    punctCache.set(cp, v);
  }
  return v;
}

function isWsCp(cp) {
  if (cp < 0) return true;
  if (cp === 32 || (cp >= 9 && cp <= 13)) return true;
  if (cp < 128) return false;
  let v = wsCache.get(cp);
  if (v === undefined) {
    v = RE_ZS.test(String.fromCodePoint(cp));
    wsCache.set(cp, v);
  }
  return v;
}

function charBefore(s, i) {
  if (i <= 0) return -1;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i - 2 >= 0) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return 0x10000 + ((h - 0xd800) << 10) + (c - 0xdc00);
  }
  return c;
}

function charAfter(s, i) {
  if (i >= s.length) return -1;
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
  }
  return c;
}

function flanking(s, runStart, runEnd) {
  const prev = charBefore(s, runStart);
  const next = charAfter(s, runEnd);
  const prevWs = isWsCp(prev);
  const prevPunct = isPunctCp(prev);
  const nextWs = isWsCp(next);
  const nextPunct = isPunctCp(next);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return [left, right];
}

// ---------------------------------------------------------------------------
// Autolinks (GFM extended autolink rules, as probed against marked)
// ---------------------------------------------------------------------------

// Trim a bare-autolink candidate the way marked does: entity truncation,
// trailing punctuation, balanced-paren rule, and truncation at an unmatched
// open paren. Loops until stable.
function trimAutolink(cand) {
  for (let pass = 0; pass < 8; pass++) {
    const before = cand;
    // Entity rule: if the candidate ends with a valid named entity, cut it.
    if (cand.length >= 2 && cand.charCodeAt(cand.length - 1) === 59) {
      let j = cand.length - 2;
      while (j >= 0 && cand.charCodeAt(j) < 128 && WORD_ASCII[cand.charCodeAt(j)]) j--;
      if (j >= 0 && cand.charCodeAt(j) === 38 && j < cand.length - 2) {
        cand = cand.slice(0, j);
      }
    }
    // Trailing punctuation.
    let e = cand.length;
    while (e > 0) {
      const c = cand.charCodeAt(e - 1);
      if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 || c === 42 || c === 95 || c === 126) e--;
      else break;
    }
    cand = cand.slice(0, e);
    // Paren rule: strip trailing ')' while it closes below the maximum depth
    // reached, or while the string has no '(' at all and closes exceed opens.
    while (cand.length > 0 && cand.charCodeAt(cand.length - 1) === 41) {
      let depth = 0;
      let maxD = 0;
      let opens = 0;
      let closes = 0;
      for (let i = 0; i < cand.length; i++) {
        const c = cand.charCodeAt(i);
        if (c === 40) {
          depth++;
          opens++;
          if (depth > maxD) maxD = depth;
        } else if (c === 41) {
          depth--;
          closes++;
        }
      }
      const depthBeforeLast = opens - closes + 1;
      if (depthBeforeLast < maxD || opens === 0) {
        cand = cand.slice(0, -1);
      } else {
        break;
      }
    }
    // Open truncation: cut before the first '(' that has no ')' after it.
    const lastClose = cand.lastIndexOf(")");
    const from = lastClose === -1 ? 0 : lastClose + 1;
    const firstOpen = cand.indexOf("(", from);
    if (firstOpen !== -1) cand = cand.slice(0, firstOpen);
    if (cand === before) break;
  }
  return cand;
}

// End of a bare-autolink candidate run: stop at ASCII whitespace/control,
// '<', '>', or DEL.
function candidateEnd(s, i) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c <= 32 || c === 60 || c === 62 || c === 127) break;
    j++;
  }
  return j;
}

// Parse a bare email starting at the first local char. Returns the end index
// (exclusive) or -1. Domain: labels of [A-Za-z0-9_-], at least two labels,
// no empty labels, last label ends with [A-Za-z0-9].
function validEmailDomain(s, a, b) {
  if (b <= a) return false;
  const domain = s.slice(a, b);
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (let li = 0; li < labels.length; li++) {
    if (labels[li].length === 0) return false;
  }
  const last = labels[labels.length - 1];
  const lc = last.charCodeAt(last.length - 1);
  if (lc >= 128 || !ALNUM_ASCII[lc]) return false;
  return true;
}

function parseBareEmail(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && s.charCodeAt(j) < 128 && LOCAL_ASCII[s.charCodeAt(j)]) j++;
  if (j === i || j >= n || s.charCodeAt(j) !== 64) return -1;
  let k = j + 1;
  while (k < n && s.charCodeAt(k) < 128 && DOMAIN_ASCII[s.charCodeAt(k)]) k++;
  while (k > j + 1 && s.charCodeAt(k - 1) === 46) k--;
  if (!validEmailDomain(s, j + 1, k)) return -1;
  return k;
}

// Bare-email scan with trailing-underscore trimming: when the maximal
// domain ends with a run of dots/underscores that invalidates it, retry
// with that suffix stripped. The first stripped underscore starts a
// delimiter run; the email is only kept if that delimiter pairs in
// emphasis processing (resolved after processEmphasis runs). Returns
// {end, trimPos} with trimPos -1 when nothing was trimmed, else the
// index of the first stripped underscore.
function parseBareEmailTrimmed(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && s.charCodeAt(j) < 128 && LOCAL_ASCII[s.charCodeAt(j)]) j++;
  if (j === i || j >= n || s.charCodeAt(j) !== 64) return null;
  let k = j + 1;
  while (k < n && s.charCodeAt(k) < 128 && DOMAIN_ASCII[s.charCodeAt(k)]) k++;
  const maxK = k;
  while (k > j + 1 && s.charCodeAt(k - 1) === 46) k--;
  if (validEmailDomain(s, j + 1, k)) return { end: k, trimPos: -1 };
  let t = maxK;
  while (t > j + 1) {
    const cc = s.charCodeAt(t - 1);
    if (cc === 46 || cc === 95) t--;
    else break;
  }
  if (t === maxK) return null;
  let us = t;
  while (us < maxK && s.charCodeAt(us) !== 95) us++;
  if (us === maxK) return null;
  if (!validEmailDomain(s, j + 1, t)) return null;
  return { end: t, trimPos: us };
}

function isWwwBoundary(s, i) {
  if (i === 0) return true;
  const c = s.charCodeAt(i - 1);
  if (c < 128 && ALNUM_ASCII[c]) return false;
  if (c === 46) return false;
  return true;
}

// If a bare-autolink candidate starting at `start` and ending at `end`
// swallowed a ']' that would close the nearest open bracket with a valid
// link/image tail, return that ']' index so the autolink ends before it;
// otherwise -1. A ']' only wins when a link actually forms: when the tail
// fails, the autolink keeps the ']' (probe-verified).
function bracketCutEnd(s, start, end, brackets, refmap) {
  if (!brackets || brackets.length === 0) return -1;
  const top = brackets[brackets.length - 1];
  if (!top.active) return -1;
  const p = s.indexOf("]", start);
  if (p === -1 || p >= end) return -1;
  const bt = parseLinkTail(s, top.srcStart, p, refmap);
  if (!bt || bt === TEXT_REJECTED) return -1;
  return p;
}

// Try a www. autolink at s[i] ('w'). Returns {node, end} or null.
function tryWww(s, i, brackets, refmap) {
  if (s.charCodeAt(i + 1) !== 119 || s.charCodeAt(i + 2) !== 119 || s.charCodeAt(i + 3) !== 46) return null;
  if (!isWwwBoundary(s, i)) return null;
  const end = candidateEnd(s, i);
  // Domain check: at least one label after "www."
  let j = i + 4;
  if (j >= end || s.charCodeAt(j) >= 128 || !LABEL_ASCII[s.charCodeAt(j)]) return null;
  while (j < end && s.charCodeAt(j) < 128 && LABEL_ASCII[s.charCodeAt(j)]) j++;
  while (j + 1 < end && s.charCodeAt(j) === 46 && s.charCodeAt(j + 1) < 128 && LABEL_ASCII[s.charCodeAt(j + 1)]) {
    j++;
    while (j < end && s.charCodeAt(j) < 128 && LABEL_ASCII[s.charCodeAt(j)]) j++;
  }
  const trimmed = trimAutolink(s.slice(i, end));
  if (trimmed.length <= 4) return null;
  const cut = bracketCutEnd(s, i, i + trimmed.length, brackets, refmap);
  if (cut !== -1) {
    const t2 = trimAutolink(s.slice(i, cut));
    if (t2.length <= 4) return null;
    return { node: { t: 6, href: "http://" + t2, text: t2, bare: true }, end: i + t2.length };
  }
  return { node: { t: 6, href: "http://" + trimmed, text: trimmed, bare: true }, end: i + trimmed.length };
}

function eqCI(s, i, word) {
  for (let k = 0; k < word.length; k++) {
    let c = s.charCodeAt(i + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== word.charCodeAt(k)) return false;
  }
  return true;
}

// Try a bare scheme autolink at s[i] ('h'/'H'/'f'/'F'). Returns {node, end} or null.
function tryScheme(s, i, brackets, refmap) {
  const c0 = s.charCodeAt(i);
  let schemeLen = 0;
  if (c0 === 104 || c0 === 72) {
    if (eqCI(s, i, "https://")) schemeLen = 8;
    else if (eqCI(s, i, "http://")) schemeLen = 7;
    else return null;
  } else if (c0 === 102 || c0 === 70) {
    if (eqCI(s, i, "ftp://")) schemeLen = 6;
    else return null;
  } else {
    return null;
  }
  const end = candidateEnd(s, i);
  if (end - i <= schemeLen) return null;
  const trimmed = trimAutolink(s.slice(i, end));
  if (trimmed.length <= schemeLen) return null;
  const cut = bracketCutEnd(s, i, i + trimmed.length, brackets, refmap);
  if (cut !== -1) {
    const t2 = trimAutolink(s.slice(i, cut));
    if (t2.length <= schemeLen) return null;
    return { node: { t: 6, href: t2, text: t2, bare: true }, end: i + t2.length };
  }
  return { node: { t: 6, href: trimmed, text: trimmed, bare: true }, end: i + trimmed.length };
}

// Try a mailto: autolink at s[i] ('m', lowercase only). Returns {node, end} or null.
function tryMailto(s, i) {
  if (s.charCodeAt(i + 1) !== 97 || s.charCodeAt(i + 2) !== 105 || s.charCodeAt(i + 3) !== 108 ||
      s.charCodeAt(i + 4) !== 116 || s.charCodeAt(i + 5) !== 111 || s.charCodeAt(i + 6) !== 58) return null;
  if (!isWwwBoundary(s, i)) return null;
  const e = parseBareEmail(s, i + 7);
  if (e === -1) return null;
  const text = s.slice(i, e);
  return { node: { t: 6, href: text, text, bare: true }, end: e };
}

// Try an xmpp: autolink at s[i] ('x', lowercase only): "xmpp:" + a valid
// bare email + an optional single path segment. Boundary: the previous
// character must not be ASCII alphanumeric.
function tryXmpp(s, i) {
  if (s.charCodeAt(i + 1) !== 109 || s.charCodeAt(i + 2) !== 112 || s.charCodeAt(i + 3) !== 112 || s.charCodeAt(i + 4) !== 58) return null;
  if (i > 0) {
    const pc = s.charCodeAt(i - 1);
    if (pc < 128 && ALNUM_ASCII[pc]) return null;
  }
  const e = parseBareEmail(s, i + 5);
  if (e === -1) return null;
  let end = e;
  if (s.charCodeAt(e) === 47) {
    let j = e + 1;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c <= 32 || c === 127 || c === 60 || c === 62 || c === 47 || c === 63 || c === 35 || c === 40 || c === 41 || c === 91 || c === 93) break;
      j++;
    }
    if (j > e + 1) end = j;
  }
  const trimmed = trimAutolink(s.slice(i, end));
  if (trimmed.length <= 5) return null;
  return { node: { t: 6, href: trimmed, text: trimmed, bare: true }, end: i + trimmed.length };
}

// Try a bare email autolink at s[i] (first local char of a run).
function tryEmail(s, i) {
  const r = parseBareEmailTrimmed(s, i);
  if (r === null) return null;
  const text = s.slice(i, r.end);
  return { node: { t: 6, href: "mailto:" + text, text, bare: true }, end: r.end, trimPos: r.trimPos };
}

// Parse a <> autolink at s[i] ('<'). Returns {node, end} or null.
function parseAngleAutolink(s, i) {
  const n = s.length;
  const c1 = s.charCodeAt(i + 1);
  // URI scheme: letter, then 1-31 more scheme chars, then ':'.
  if ((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122)) {
    let k = i + 1;
    while (k < n && s.charCodeAt(k) < 128 && SCHEME_ASCII[s.charCodeAt(k)]) k++;
    const schemeLen = k - (i + 1);
    if (schemeLen >= 2 && schemeLen <= 32 && k < n && s.charCodeAt(k) === 58) {
      let m = k + 1;
      let ok = false;
      while (m < n) {
        const c = s.charCodeAt(m);
        if (c === 62) {
          ok = true;
          break;
        }
        if (c <= 32 || c === 60 || c === 127) break;
        m++;
      }
      if (ok) {
        const text = s.slice(i + 1, m);
        return { node: { t: 6, href: text, text, bare: false }, end: m + 1 };
      }
    }
  }
  // Email: strict labels — [A-Za-z0-9] with hyphens only inside.
  let j = i + 1;
  while (j < n && s.charCodeAt(j) < 128 && LOCAL_ASCII[s.charCodeAt(j)]) j++;
  if (j > i + 1 && j < n && s.charCodeAt(j) === 64) {
    let k = j + 1;
    let labels = 0;
    let ok = true;
    while (true) {
      if (k >= n || s.charCodeAt(k) >= 128 || !ALNUM_ASCII[s.charCodeAt(k)]) {
        ok = false;
        break;
      }
      const labelStart = k;
      k++;
      while (k < n && ((s.charCodeAt(k) < 128 && ALNUM_ASCII[s.charCodeAt(k)]) || s.charCodeAt(k) === 45)) k++;
      if (s.charCodeAt(k - 1) === 45) {
        ok = false;
        break;
      }
      labels++;
      if (k < n && s.charCodeAt(k) === 46) {
        k++;
        continue;
      }
      break;
    }
    if (ok && labels >= 2 && k < n && s.charCodeAt(k) === 62) {
      const text = s.slice(i + 1, k);
      return { node: { t: 6, href: "mailto:" + text, text, bare: false }, end: k + 1 };
    }
  }
  return null;
}

// Parse an inline HTML tag at s[i] ('<'). Returns the end index (exclusive)
// or -1 when no valid tag starts here. Handles comments, processing
// instructions, declarations, CDATA, open and close tags.
function parseHtmlTag(s, i) {
  const n = s.length;
  if (s.charCodeAt(i + 1) === 33) {
    if (s.charCodeAt(i + 2) === 45 && s.charCodeAt(i + 3) === 45) {
      const e = s.indexOf("-->", i + 2);
      return e === -1 ? -1 : e + 3;
    }
    if (s.startsWith("<![CDATA[", i)) {
      const e = s.indexOf("]]>", i + 9);
      return e === -1 ? -1 : e + 3;
    }
    const c2 = s.charCodeAt(i + 2);
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) {
      const e = s.indexOf(">", i + 3);
      return e === -1 ? -1 : e + 1;
    }
    return -1;
  }
  if (s.charCodeAt(i + 1) === 63) {
    const e = s.indexOf("?>", i + 2);
    return e === -1 ? -1 : e + 2;
  }
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) {
    closing = true;
    j++;
  }
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  j++;
  while (j < n && s.charCodeAt(j) < 128 && TAGNAME_ASCII[s.charCodeAt(j)]) j++;
  if (closing) {
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 12 || c === 11) j++;
      else break;
    }
    return s.charCodeAt(j) === 62 ? j + 1 : -1;
  }
  // Attributes must be preceded by whitespace, but the whitespace may
  // have been consumed by the post-name skip of a valueless attribute.
  let pendingWs = false;
  while (true) {
    const wsStart = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 12 || c === 11) j++;
      else break;
    }
    if (j >= n) return -1;
    if (s.charCodeAt(j) === 62) return j + 1;
    if (s.charCodeAt(j) === 47 && s.charCodeAt(j + 1) === 62) return j + 2;
    if (j === wsStart && !pendingWs) return -1;
    pendingWs = false;
    // Attribute name.
    const ac = s.charCodeAt(j);
    if (!((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac === 95 || ac === 58)) return -1;
    j++;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c < 128 && ALNUM_ASCII[c]) || c === 95 || c === 58 || c === 46 || c === 45) j++;
      else break;
    }
    const nameWsStart = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 12 || c === 11) j++;
      else break;
    }
    if (s.charCodeAt(j) === 61) {
      j++;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c === 32 || c === 9 || c === 10 || c === 12 || c === 11) j++;
        else break;
      }
      if (j >= n) return -1;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        const e = s.indexOf(s[j], j + 1);
        if (e === -1) return -1;
        j = e + 1;
      } else {
        const start = j;
        while (j < n) {
          const c = s.charCodeAt(j);
          if (c === 32 || c === 9 || c === 10 || c === 12 || c === 11 || c === 34 || c === 39 || c === 61 || c === 60 || c === 62 || c === 96) break;
          j++;
        }
        if (j === start) return -1;
      }
    } else {
      pendingWs = j > nameWsStart;
    }
  }
}

// ---------------------------------------------------------------------------
// Links: destinations, titles, labels, references
// ---------------------------------------------------------------------------

const FOLD_MAP = {
  "\u00DF": "ss",
  "\u03C2": "\u03C3",
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
  "\uFB05": "st",
  "\uFB06": "st",
  "\uFB13": "\u0544\u0576",
  "\uFB14": "\u0544\u0565",
  "\uFB15": "\u0544\u056B",
  "\uFB16": "\u057E\u0576",
  "\uFB17": "\u0544\u056D",
};
const FOLD_RE = /[\u00DF\u03C2\uFB00-\uFB06\uFB13-\uFB17]/g;

// Link labels compare with Unicode case folding, not plain lowercasing:
// ẞ/ß fold to "ss", final sigma ς folds to σ, and ligatures expand.
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, " ").toLowerCase().replace(FOLD_RE, (ch) => FOLD_MAP[ch]);
}

function isWsLink(c) {
  return c === 32 || c === 9 || c === 10;
}

function skipLinkWs(s, p) {
  while (p < s.length && isWsLink(s.charCodeAt(p))) p++;
  return p;
}

// Parse a bracketed label starting at s[p] ('['). Returns {label, end}
// (end is just past the closing ']') or null.
// Parse a bracketed label starting at s[p] ('['). Labels end at the FIRST
// unescaped ']' (no bracket nesting). Returns {label, end} or null.
function parseLabel(s, p) {
  const n = s.length;
  let q = p + 1;
  while (q < n) {
    const c = s.charCodeAt(q);
    if (c === 92) {
      if (q + 1 >= n) return null;
      q += 2;
      continue;
    }
    if (c === 91) return null;
    if (c === 93) {
      const label = s.slice(p + 1, q);
      if (label.length > 999) return null;
      return { label, end: q + 1 };
    }
    if (c === 10) {
      let r = q + 1;
      while (r < n && (s.charCodeAt(r) === 32 || s.charCodeAt(r) === 9)) r++;
      if (r >= n || s.charCodeAt(r) === 10) return null;
    }
    q++;
  }
  return null;
}

// Parse an inline link tail starting just after '(' at s[p]. Returns
// {href, title, end} or null.
function parseInlineLinkTail(s, p) {
  const n = s.length;
  p = skipLinkWs(s, p);
  if (p < n && s.charCodeAt(p) === 41) return { href: "", title: null, end: p + 1 };
  let dest = "";
  let q;
  if (p < n && s.charCodeAt(p) === 60) {
    // <> destination: no newline, no unescaped '<', escapes processed.
    let out = "";
    q = p + 1;
    let closed = false;
    while (q < n) {
      const c = s.charCodeAt(q);
      if (c === 62) {
        closed = true;
        q++;
        break;
      }
      if (c === 60 || c === 10 || c === 127 || (c < 32 && c !== 9)) return null;
      if (c === 92 && q + 1 < n && s.charCodeAt(q + 1) < 128 && PUNCT_ASCII[s.charCodeAt(q + 1)]) {
        out += s[q + 1];
        q += 2;
        continue;
      }
      out += s[q];
      q++;
    }
    if (!closed) return null;
    dest = out;
  } else {
    // Bare destination: balanced parens, stops at whitespace.
    let out = "";
    let depth = 0;
    q = p;
    while (q < n) {
      const c = s.charCodeAt(q);
      if (c <= 32 || c === 127) break;
      if (c === 40) {
        depth++;
        out += s[q];
        q++;
        continue;
      }
      if (c === 41) {
        if (depth === 0) break;
        depth--;
        out += s[q];
        q++;
        continue;
      }
      if (c === 92 && q + 1 < n && s.charCodeAt(q + 1) < 128 && PUNCT_ASCII[s.charCodeAt(q + 1)]) {
        out += s[q + 1];
        q += 2;
        continue;
      }
      out += s[q];
      q++;
    }
    dest = out;
  }
  let p2 = skipLinkWs(s, q);
  if (p2 < n && s.charCodeAt(p2) === 41) return { href: dest, title: null, end: p2 + 1 };
  if (p2 === q) return null;
  // Optional title (requires whitespace between it and the destination).
  const qc = s.charCodeAt(p2);
  let title = null;
  let q2;
  if (qc === 34 || qc === 39) {
    let out = "";
    q2 = p2 + 1;
    let closed = false;
    while (q2 < n) {
      const c = s.charCodeAt(q2);
      if (c === qc) {
        closed = true;
        q2++;
        break;
      }
      if (c === 92 && q2 + 1 < n && s.charCodeAt(q2 + 1) < 128 && PUNCT_ASCII[s.charCodeAt(q2 + 1)]) {
        out += s[q2 + 1];
        q2 += 2;
        continue;
      }
      out += s[q2];
      q2++;
    }
    if (!closed) return null;
    title = out;
  } else if (qc === 40) {
    let out = "";
    let depth = 1;
    q2 = p2 + 1;
    let closed = false;
    while (q2 < n) {
      const c = s.charCodeAt(q2);
      if (c === 92 && q2 + 1 < n && s.charCodeAt(q2 + 1) < 128 && PUNCT_ASCII[s.charCodeAt(q2 + 1)]) {
        out += s[q2 + 1];
        q2 += 2;
        continue;
      }
      if (c === 40) {
        depth++;
        out += s[q2];
        q2++;
        continue;
      }
      if (c === 41) {
        depth--;
        if (depth === 0) {
          closed = true;
          q2++;
          break;
        }
        out += s[q2];
        q2++;
        continue;
      }
      out += s[q2];
      q2++;
    }
    if (!closed) return null;
    title = out;
  } else {
    return null;
  }
  const p3 = skipLinkWs(s, q2);
  if (p3 < n && s.charCodeAt(p3) === 41) return { href: dest, title, end: p3 + 1 };
  return null;
}

// Resolve a link/image tail at a closing bracket. text: full paragraph text.
// bracketStart: index just after the opening '['. closeIdx: index of ']'.
// refmap: label -> {href, title}. Returns {href, title, end} or null.
// Marked rejects an inline or full/collapsed-reference link when the link
// text holds an ODD number of (unescaped) backtick runs, unless the text
// ends with a backtick run of length >= 2 (probes 62-67, 8/8 predictions
// verified). Shortcut references are exempt. Even run counts always pass.
function linkTextBacktickOk(s, a, b) {
  const first = s.indexOf("`", a);
  if (first === -1 || first >= b) return true;
  let runs = 0;
  let lastRunLen = 0;
  let endsWithRun = false;
  // Scan from a, not from first: the first backtick may be escaped (\`),
  // and the escape skip only works if the backslash is encountered first.
  let i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < b) {
      i += 2;
      endsWithRun = false;
      continue;
    }
    if (c === 96) {
      let j = i + 1;
      while (j < b && s.charCodeAt(j) === 96) j++;
      runs++;
      lastRunLen = j - i;
      endsWithRun = j === b;
      i = j;
    } else {
      endsWithRun = false;
      i++;
    }
  }
  if ((runs & 1) === 0) return true;
  return endsWithRun && lastRunLen >= 2;
}

// Whether a parenthesized tail starting just after '(' (at p) has a closing
// ')': paren-depth scan, backslash escapes skipped, quotes and <> do not
// protect (probes 71-72). Used for the failed-tail emphasis suppression.
function tailClosed(s, p) {
  const n = s.length;
  let depth = 0;
  while (p < n) {
    const c = s.charCodeAt(p);
    if (c === 92 && p + 1 < n) {
      p += 2;
      continue;
    }
    if (c === 40) depth++;
    else if (c === 41) {
      if (depth === 0) return true;
      depth--;
    }
    p++;
  }
  return false;
}

// Returned by parseLinkTail when the inline tail parses but the link text
// is rejected by the backtick rule (and no shortcut def exists): the link
// does not form, but emphasis inside the text is NOT suppressed (probe74),
// unlike a genuinely invalid tail. Callers must treat it as "no link".
const TEXT_REJECTED = { rejected: true };

function parseLinkTail(text, bracketStart, closeIdx, refmap) {
  const after = closeIdx + 1;
  const nc = text.charCodeAt(after);
  if (nc === 40) {
    const tail = parseInlineLinkTail(text, after + 1);
    if (tail && linkTextBacktickOk(text, bracketStart, closeIdx)) return tail;
    // A failed inline tail falls back to the shortcut reference.
    const norm = normalizeLabel(text.slice(bracketStart, closeIdx));
    if (norm !== "") {
      const def = refmap.get(norm);
      if (def) return { href: def.href, title: def.title, end: after };
    }
    if (tail) return TEXT_REJECTED;
    return null;
  }
  if (nc === 91) {
    if (!linkTextBacktickOk(text, bracketStart, closeIdx)) return null;
    if (text.charCodeAt(after + 1) === 93) {
      const norm = normalizeLabel(text.slice(bracketStart, closeIdx));
      const def = refmap.get(norm);
      if (def) return { href: def.href, title: def.title, end: after + 2 };
      return null;
    }
    const lab = parseLabel(text, after);
    if (!lab) return null;
    const def = refmap.get(normalizeLabel(lab.label));
    if (def) return { href: def.href, title: def.title, end: lab.end };
    return null;
  }
  const norm = normalizeLabel(text.slice(bracketStart, closeIdx));
  if (norm === "") return null;
  const def = refmap.get(norm);
  if (def) return { href: def.href, title: def.title, end: after };
  return null;
}

// ---------------------------------------------------------------------------
// Inline scanner
// ---------------------------------------------------------------------------
// Node types: 0 text, 1 raw (verbatim), 2 code, 3 br, 4 link, 5 img,
// 6 autolink, 7 bracket marker, 8 delimiter, 9 soft break,
// 10 em, 11 strong, 12 del.

const SPECIALS_RE = /[\\`*_~[\]!<&\n]/;
function hasSpecials(text) {
  if (SPECIALS_RE.test(text)) return true;
  if (text.indexOf("www.") !== -1) return true;
  if (text.indexOf("://") !== -1) return true;
  if (text.indexOf("@") !== -1) return true;
  return false;
}

function parseInline(text, refmap) {
  if (!hasSpecials(text)) return [{ t: 0, s: text }];
  const nodes = [];
  const brackets = [];
  // Trimmed bare emails awaiting their trailing "_" delimiter node, so
  // the link can be undone if that delimiter never pairs (probes 49-52).
  const pendingTrims = [];
  let buf = "";
  let bufLitBt = false;
  let i = 0;
  const n = text.length;
  let lastNonText = true;
  const flush = () => {
    if (buf !== "") {
      nodes.push(bufLitBt ? { t: 0, s: buf, _litBt: true } : { t: 0, s: buf });
      buf = "";
      bufLitBt = false;
    }
  };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 119) {
      const r = tryWww(text, i, brackets, refmap);
      if (r) {
        flush();
        nodes.push(r.node);
        i = r.end;
        lastNonText = true;
        continue;
      }
    } else if (c === 104 || c === 72 || c === 102 || c === 70) {
      const r = tryScheme(text, i, brackets, refmap);
      if (r) {
        flush();
        nodes.push(r.node);
        i = r.end;
        lastNonText = true;
        continue;
      }
    } else if (c === 109) {
      const r = tryMailto(text, i);
      if (r) {
        flush();
        nodes.push(r.node);
        i = r.end;
        lastNonText = true;
        continue;
      }
    } else if (c === 120) {
      const r = tryXmpp(text, i);
      if (r) {
        flush();
        nodes.push(r.node);
        i = r.end;
        lastNonText = true;
        continue;
      }
    }
    // Email attempt at a run boundary, except on characters that form markup
    // of their own (delimiters, backtick, entity start); those are handled
    // by the scanner below and the attempt fires after them instead.
    if (c < 128 && LOCAL_ASCII[c] && c !== 96 && c !== 42 && c !== 95 && c !== 126 && c !== 38 &&
        !(c === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91) &&
        (i === 0 || lastNonText || !(text.charCodeAt(i - 1) < 128 && LOCAL_ASCII[text.charCodeAt(i - 1)]))) {
      const r = tryEmail(text, i);
      if (r) {
        flush();
        nodes.push(r.node);
        if (r.trimPos !== -1) pendingTrims.push({ node: r.node, trimPos: r.trimPos });
        i = r.end;
        lastNonText = true;
        continue;
      }
    }
    if (c === 92) {
      // Backslash escape / hard break.
      if (i + 1 < n) {
        const nc = text.charCodeAt(i + 1);
        if (nc < 128 && PUNCT_ASCII[nc]) {
          buf += text[i + 1];
          i += 2;
          lastNonText = false;
          continue;
        }
        if (nc === 10) {
          flush();
          nodes.push({ t: 3 });
          i += 2;
          while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
          lastNonText = true;
          continue;
        }
      }
      buf += "\\";
      i++;
      lastNonText = false;
      continue;
    }
    if (c === 96) {
      // Code span: closing run must match the opening run length exactly.
      // Inside an open bracket, a span may not cross a ']' that would close
      // that bracket (probes 62/65, doc-09/28/35): if the first exact closer
      // lies past such a ']', the opener stays literal and the ']' wins.
      let run = 1;
      while (i + run < n && text.charCodeAt(i + run) === 96) run++;
      let j = i + run;
      let found = -1;
      while (j < n) {
        const k = text.indexOf("`", j);
        if (k === -1) break;
        let m = 1;
        while (k + m < n && text.charCodeAt(k + m) === 96) m++;
        if (m === run) {
          found = k;
          break;
        }
        j = k + m;
      }
      if (found !== -1 && brackets.length > 0) {
        const top = brackets[brackets.length - 1];
        if (top.active) {
          let q = i + run;
          while (q < found) {
            const qc = text.charCodeAt(q);
            if (qc === 92) {
              q += 2;
              continue;
            }
            if (qc === 93) {
              const bt = parseLinkTail(text, top.srcStart, q, refmap);
              if (bt && bt !== TEXT_REJECTED) {
                found = -1;
                break;
              }
            }
            q++;
          }
        }
      }
      if (found !== -1) {
        let content = text.slice(i + run, found);
        if (content.indexOf("\n") !== -1) content = content.replace(/\n/g, " ");
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32) {
          let allSpaces = true;
          for (let q = 0; q < content.length; q++) {
            if (content.charCodeAt(q) !== 32) {
              allSpaces = false;
              break;
            }
          }
          if (!allSpaces) content = content.slice(1, -1);
        }
        flush();
        nodes.push({ t: 2, s: content });
        i = found + run;
        lastNonText = true;
      } else {
        buf += text.slice(i, i + run);
        bufLitBt = true;
        i += run;
        lastNonText = false;
      }
      continue;
    }
    if (c === 42 || c === 95 || c === 126) {
      const ch = text[i];
      let run = 1;
      while (i + run < n && text.charCodeAt(i + run) === c) run++;
      if (c === 126 && run > 2) {
        buf += text.slice(i, i + run);
        i += run;
        lastNonText = false;
        continue;
      }
      const [left, right] = flanking(text, i, i + run);
      let canOpen;
      let canClose;
      if (c === 95) {
        const prev = charBefore(text, i);
        const next = charAfter(text, i + run);
        canOpen = left && (!right || isPunctCp(prev));
        canClose = right && (!left || isPunctCp(next));
      } else {
        canOpen = left;
        canClose = right;
      }
      flush();
      const delimNode = { t: 8, ch, len: run, o: canOpen, c: canClose };
      if (c === 95) {
        for (let pi = 0; pi < pendingTrims.length; pi++) {
          if (pendingTrims[pi].trimPos === i) {
            pendingTrims[pi].node._trimDelim = delimNode;
            delimNode._trimOrig = run;
            nodes._hasTrims = true;
            pendingTrims.splice(pi, 1);
            break;
          }
        }
      }
      nodes.push(delimNode);
      i += run;
      lastNonText = true;
      continue;
    }
    if (c === 91) {
      flush();
      const marker = { t: 7, img: false };
      nodes.push(marker);
      brackets.push({ marker, srcStart: i + 1, img: false, active: true });
      i++;
      lastNonText = true;
      continue;
    }
    if (c === 33) {
      if (i + 1 < n && text.charCodeAt(i + 1) === 91) {
        flush();
        const marker = { t: 7, img: true };
        nodes.push(marker);
        brackets.push({ marker, srcStart: i + 2, img: true, active: true });
        i += 2;
        lastNonText = true;
        continue;
      }
      buf += "!";
      i++;
      lastNonText = false;
      continue;
    }
    if (c === 93) {
      if (brackets.length === 0) {
        buf += "]";
        i++;
        lastNonText = false;
        continue;
      }
      // A ']' always looks at the nearest (top) bracket. An inactive top
      // bracket blocks the attempt: the ']' is literal and the bracket is
      // removed. A formed link deactivates earlier LINK brackets only;
      // image brackets stay active.
      const bracket = brackets[brackets.length - 1];
      if (!bracket.active) {
        brackets.pop();
        bracket.marker.t = 0;
        bracket.marker.s = bracket.img ? "![" : "[";
        buf += "]";
        i++;
        lastNonText = false;
        continue;
      }
      const res = parseLinkTail(text, bracket.srcStart, i, refmap);
      if (res && res !== TEXT_REJECTED) {
        flush();
        const markerIdx = nodes.indexOf(bracket.marker);
        const children = nodes.slice(markerIdx + 1);
        convertBareAutolinks(children);
        nodes.length = markerIdx;
        if (bracket.img) {
          nodes.push({ t: 5, href: res.href, title: res.title, ch: children });
        } else {
          nodes.push({ t: 4, href: res.href, title: res.title, ch: children });
          for (const b of brackets) if (!b.img) b.active = false;
        }
        brackets.pop();
        i = res.end;
        lastNonText = true;
      } else {
        // Failed link: emphasis inside this bracket's text is suppressed
        // when (a) the inline tail itself is invalid but closed (probes
        // 69-72), or (b) the tail parsed but the text was backtick-rejected
        // AND a code span inside the text contains a backtick (probes
        // 62/77/78). Mark its delimiter nodes dead; the flag travels with
        // the node if an outer link later forms.
        let suppress = false;
        if (text.charCodeAt(i + 1) === 40) {
          if (res === null) {
            suppress = tailClosed(text, i + 2);
          } else if (res === TEXT_REJECTED) {
            const markerIdx0 = nodes.indexOf(bracket.marker);
            for (let k = markerIdx0 + 1; k < nodes.length; k++) {
              if (nodes[k].t === 2 && nodes[k].s.indexOf("`") !== -1) {
                suppress = true;
                break;
              }
            }
          }
        }
        if (suppress) {
          const markerIdx = nodes.indexOf(bracket.marker);
          for (let k = markerIdx + 1; k < nodes.length; k++) {
            if (nodes[k].t === 8) nodes[k].dead = true;
          }
        }
        brackets.pop();
        bracket.marker.t = 0;
        bracket.marker.s = bracket.img ? "![" : "[";
        buf += "]";
        i++;
        lastNonText = false;
      }
      continue;
    }
    if (c === 60) {
      const auto = parseAngleAutolink(text, i);
      if (auto) {
        flush();
        nodes.push(auto.node);
        i = auto.end;
        lastNonText = true;
        continue;
      }
      const tagEnd = parseHtmlTag(text, i);
      if (tagEnd !== -1) {
        flush();
        nodes.push({ t: 1, s: text.slice(i, tagEnd) });
        i = tagEnd;
        lastNonText = true;
        continue;
      }
      buf += "<";
      i++;
      lastNonText = false;
      continue;
    }
    if (c === 38) {
      if (i + 1 < n && text.charCodeAt(i + 1) === 35) {
        const dec = decodeNumeric(text, i);
        if (dec) {
          buf += dec.ch;
          i = dec.end;
          lastNonText = false;
          continue;
        }
      } else {
        const e = entityEnd(text, i);
        if (e !== -1) {
          flush();
          nodes.push({ t: 1, s: text.slice(i, e) });
          i = e;
          lastNonText = true;
          continue;
        }
      }
      buf += "&";
      i++;
      lastNonText = false;
      continue;
    }
    if (c === 10) {
      // Soft break, or hard break when preceded by two or more spaces.
      let spaces = 0;
      let q = buf.length;
      while (q > 0 && buf.charCodeAt(q - 1) === 32) {
        spaces++;
        q--;
      }
      if (spaces >= 2) {
        buf = buf.slice(0, q);
        flush();
        nodes.push({ t: 3 });
        i++;
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        lastNonText = true;
      } else {
        flush();
        nodes.push({ t: 9 });
        i++;
        lastNonText = true;
      }
      continue;
    }
    buf += text[i];
    i++;
    lastNonText = false;
  }
  flush();
  return nodes;
}

// Bare autolinks do not fire inside link or image text; convert them back
// to plain text nodes when a link or image forms around them.
function convertBareAutolinks(children) {
  for (let k = 0; k < children.length; k++) {
    const nd = children[k];
    if (nd.t === 6 && nd.bare) {
      children[k] = { t: 0, s: nd.text };
    } else if (nd.t === 4 || nd.t === 5 || nd.t === 10 || nd.t === 11 || nd.t === 12) {
      convertBareAutolinks(nd.ch);
    }
  }
}

// ---------------------------------------------------------------------------
// Emphasis: the CommonMark delimiter-stack algorithm
// ---------------------------------------------------------------------------

function processEmphasis(nodes) {
  for (const nd of nodes) {
    if (nd.t === 4 || nd.t === 5) processEmphasis(nd.ch);
  }
  let delims = [];
  for (const nd of nodes) {
    if (nd.t === 8 && !nd.dead) delims.push(nd);
  }
  if (delims.length === 0) return;
  const bottoms = new Map();
  let di = 0;
  while (di < delims.length) {
    const closer = delims[di];
    if (!closer.c) {
      di++;
      continue;
    }
    const key = closer.ch + ":" + (closer.len % 3);
    const bottom = bottoms.get(key);
    const ciNode = nodes.indexOf(closer);
    let opener = null;
    let rejected = false;
    let oi = di - 1;
    while (oi >= 0) {
      const cand = delims[oi];
      if (bottom !== undefined && cand === bottom) break;
      if (cand.ch === closer.ch && cand.o) {
        if (closer.ch === "~" && cand.len !== closer.len) {
          oi--;
          continue;
        }
        const odd = ((closer.o && closer.c) || (cand.o && cand.c)) && (cand.len + closer.len) % 3 === 0 && !(cand.len % 3 === 0 && closer.len % 3 === 0);
        if (!odd) {
          if (closer.ch !== "~" && barrierBlocks(nodes, cand, closer, ciNode)) {
            rejected = true;
            oi--;
            continue;
          }
          opener = cand;
          break;
        }
        rejected = true;
      }
      oi--;
    }
    if (opener === null) {
      if (rejected && closer.ch !== "~") closer._failedCloser = true;
      if (di > 0) bottoms.set(key, delims[di - 1]);
      if (!closer.o) {
        delims.splice(di, 1);
      } else {
        di++;
      }
      continue;
    }
    let use = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
    if (closer.ch === "~") use = opener.len;
    const oLenBefore = opener.len;
    const cLenBefore = closer.len;
    const oBoth = opener.o && opener.c;
    const cBoth = closer.o && closer.c;
    const isContinuation = closer._remOf !== undefined && closer._remOf._oNode === opener;
    opener.len -= use;
    closer.len -= use;
    const oiNode = nodes.indexOf(opener);
    const inner = nodes.slice(oiNode + 1, ciNode);
    const wrapType = closer.ch === "~" ? 12 : use === 2 ? 11 : 10;
    const wrap = { t: wrapType, ch: inner };
    // Barrier metadata (probes 88-96): the match's opener/closer lengths
    // and flanking at match time, plus the node identities for the
    // pair-continuation rule and the remainder-placement post-pass.
    wrap._ch = closer.ch;
    wrap._oLen = oLenBefore;
    wrap._cLen = cLenBefore;
    wrap._oBoth = oBoth;
    wrap._cBoth = cBoth;
    wrap._use = use;
    wrap._oNode = opener;
    wrap._cNode = closer;
    wrap._isContinuation = isContinuation;
    wrap._oRem = opener.len > 0 ? opener : null;
    wrap._cRem = closer.len > 0 ? closer : null;
    const repl = [];
    if (opener.len > 0) {
      repl.push(opener);
      delete opener._remOf;
    } else {
      const k = delims.indexOf(opener);
      if (k !== -1) delims.splice(k, 1);
    }
    repl.push(wrap);
    if (closer.len > 0) {
      repl.push(closer);
      closer._remOf = wrap;
    } else {
      const k = delims.indexOf(closer);
      if (k !== -1) delims.splice(k, 1);
    }
    nodes.splice(oiNode, ciNode - oiNode + 1, ...repl);
    for (const nd of inner) {
      if (nd.t === 8) {
        const k = delims.indexOf(nd);
        if (k !== -1) delims.splice(k, 1);
      }
    }
    // Lengths changed; rescan from the start over the maintained list.
    di = 0;
  }
  placeRemainders(nodes);
}

// Barrier check (probes 89-96): a match whose opener was open-only and
// whose closer was BOTH blocks a later closer from matching an earlier
// opener across it, unless a delimiter that cannot open sits between the
// match and the closer (lifting), or the formula allows the pair:
// allowed iff c >= o and ((o+v)%3 != 0 or c >= o+v), v = match closer len.
// A closer remainder crossing its own match to reach a different opener
// follows the same rule; reaching the same match's opener remainder
// (pair continuation) is exempt from that wrap's barrier.
function barrierBlocks(nodes, cand, closer, ciNode) {
  const oiNode = nodes.indexOf(cand);
  // Scan wraps between cand and closer, nearest to the closer first.
  for (let w = ciNode - 1; w > oiNode; w--) {
    const nd = nodes[w];
    if (nd.t !== 10 && nd.t !== 11 && nd.t !== 12) continue;
    if (nd._ch !== closer.ch) continue;
    if (nd === closer._remOf && cand === nd._oNode) continue;
    if (nd._oBoth || !nd._cBoth) continue;
    // Lifting: a delimiter that cannot open between the wrap and closer
    // lifts the barrier, but only when the pair's lengths are not
    // mod-3-suspicious (doc-01 lifts at (2,2); doc-11 stays blocked
    // at (1,2)).
    let lifted = false;
    for (let k = w + 1; k < ciNode; k++) {
      const mid = nodes[k];
      if (mid.t === 8 && !mid.o) {
        lifted = true;
        break;
      }
    }
    if (lifted && (cand.len + closer.len) % 3 !== 0) continue;
    const o = cand.len;
    const c = closer.len;
    const v = nd._cLen;
    if (c < o) return true;
    if ((o + v) % 3 === 0 && c < o + v) return true;
  }
  return false;
}

// Remainder placement post-pass (probe88): after all matching, leftover
// delimiter runs adjacent to the wrap their match produced move inside
// the wrap when the placement rule says so. Runs after matching so
// remainders stay live delimiters while pairing continues.
function placeRemainders(nodes) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const nd = nodes[i];
    if (nd.t !== 10 && nd.t !== 11 && nd.t !== 12) continue;
    placeRemainders(nd.ch);
    if (nd._ch === "~") continue;
    if (!nd._oRem && !nd._cRem) continue;
    const oAdj = nd._oRem !== null && i > 0 && nodes[i - 1] === nd._oRem;
    const cAdj = nd._cRem !== null && i + 1 < nodes.length && nodes[i + 1] === nd._cRem;
    if (!oAdj && !cAdj) continue;
    const closerLen = nd._cRem !== null ? nd._cRem.len : 0;
    if (!remainderInside(nd.ch, nd._use, nd._isContinuation, nd._ch, closerLen)) continue;
    if (cAdj) {
      nodes.splice(i + 1, 1);
      nd.ch.push(nd._cRem);
    }
    if (oAdj) {
      nodes.splice(i - 1, 1);
      nd.ch.unshift(nd._oRem);
    }
  }
}

// Remainder placement (probe88): decide whether the leftover delimiter
// runs of a match go inside the wrap. Needs an intervening wrap or
// delimiter with no whitespace between it and the closer, and (for wraps)
// a use different from the intervening wrap's use; pair continuations
// invert the use comparison. Delimiter-intervening always places inside.
function remainderInside(inner, use, isContinuation, ch, closerLen) {
  if (ch === "~") return false;
  let lastIdx = -1;
  for (let k = inner.length - 1; k >= 0; k--) {
    const nd = inner[k];
    if (nd.t === 8 || nd.t === 10 || nd.t === 11 || nd.t === 12) {
      lastIdx = k;
      break;
    }
  }
  if (lastIdx === -1) return false;
  let seg = "";
  for (let k = lastIdx + 1; k < inner.length; k++) {
    seg += plainTextOf(inner[k]);
  }
  if (seg.length === 0 || /[\s]/.test(seg)) return false;
  // The segment must contain a letter or number: pure punctuation
  // segments (`!`, backtick, `.`) keep the remainder outside (probe103).
  if (!/[\p{L}\p{N}]/u.test(seg)) return false;
  const last = inner[lastIdx];
  if (last.t === 8) return true;
  if (closerLen > use) return true;
  const diff = last._use !== use;
  return isContinuation ? !diff : diff;
}

function plainTextOf(nd) {
  if (nd.t === 0 || nd.t === 1) return nd.s;
  if (nd.t === 2) return nd.s;
  if (nd.t === 3) return "";
  if (nd.t === 8) return nd.ch.repeat(nd.len);
  if (nd.t === 9) return "\n";
  if (nd.t === 4 || nd.t === 5 || nd.t === 10 || nd.t === 11 || nd.t === 12) {
    let s = "";
    for (const c of nd.ch) s += plainTextOf(c);
    return s;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Inline rendering: HTML mode and plain-text mode (image alt text)
// ---------------------------------------------------------------------------

function renderNodes(nodes, mode) {
  const parts = [];
  for (const nd of nodes) {
    switch (nd.t) {
      case 0:
        parts.push(mode === 0 ? escapeText(nd.s) : nd.s);
        break;
      case 1:
        parts.push(nd.s);
        break;
      case 2:
        if (mode === 0) parts.push("<code>", escapeText(nd.s), "</code>");
        else parts.push(nd.s);
        break;
      case 3:
        if (mode === 0) parts.push("<br>");
        break;
      case 9:
        parts.push("\n");
        break;
      case 8:
        parts.push(nd.ch.repeat(nd.len));
        break;
      case 4:
        if (mode === 0) {
          parts.push('<a href="', escapeAttrPreserve(cleanUrl(nd.href)), '"');
          if (nd.title !== null && nd.title !== undefined) parts.push(' title="', escapeAttrPreserve(nd.title), '"');
          parts.push(">", renderNodes(nd.ch, 0), "</a>");
        } else {
          parts.push(renderNodes(nd.ch, 1));
        }
        break;
      case 5:
        if (mode === 0) {
          parts.push('<img src="', escapeAttrPreserve(cleanUrl(nd.href)), '" alt="', escapeAttrPreserve(renderNodes(nd.ch, 1)), '"');
          if (nd.title !== null && nd.title !== undefined) parts.push(' title="', escapeAttrPreserve(nd.title), '"');
          parts.push(">");
        } else {
          parts.push(renderNodes(nd.ch, 1));
        }
        break;
      case 6:
        if (mode === 0) {
          parts.push('<a href="', escapeText(cleanUrl(nd.href)), '">', escapeText(nd.text), "</a>");
        } else {
          parts.push(nd.text);
        }
        break;
      case 10:
      case 11:
      case 12: {
        const tag = nd.t === 10 ? "em" : nd.t === 11 ? "strong" : "del";
        if (mode === 0) parts.push("<" + tag + ">", renderNodes(nd.ch, 0), "</" + tag + ">");
        else parts.push(renderNodes(nd.ch, 1));
        break;
      }
      case 7:
        parts.push(nd.img ? "![" : "[");
        break;
    }
  }
  return parts.join("");
}

// After emphasis processing, undo trimmed bare-email links whose trailing
// "_" delimiter never paired: such a delimiter is still in the tree at its
// original length. A paired delimiter is gone from the tree or shortened.
function resolveTrimmedEmails(nodes) {
  const stack = [...nodes];
  const emails = [];
  const delimLens = new Map();
  while (stack.length > 0) {
    const nd = stack.pop();
    if (nd.t === 6 && nd._trimDelim) emails.push(nd);
    else if (nd.t === 8 && nd._trimOrig !== undefined) delimLens.set(nd, nd.len);
    if (nd.t === 4 || nd.t === 5 || nd.t === 10 || nd.t === 11 || nd.t === 12) {
      for (const ch of nd.ch) stack.push(ch);
    }
  }
  for (const em of emails) {
    const d = em._trimDelim;
    if (delimLens.get(d) === d._trimOrig) {
      em.t = 0;
      em.s = em.text;
    }
    delete em._trimDelim;
  }
}

// Marked keeps a document-global "inside raw <a>" flag (probes 57-61): an
// inline HTML start tag whose text matches /^<a /i sets it, an inline tag
// exactly "</a>" (case-insensitive) clears it, and while set, bare
// autolinks (www/scheme/mailto/email/xmpp) do not form. Bracket links,
// images and <> autolinks are unaffected. Tags inside link/image children
// do not touch the flag; tags inside emphasis do (they are top-level at
// scan time). The flag is positional within a paragraph and persists
// across blocks in document order. Applied to the pre-emphasis node list:
// bare autolink nodes appearing while the flag is set become plain text.
function applyRawLink(nodes, st) {
  let flag = st.rawLink;
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t === 1) {
      const s = nd.s;
      const c1 = s.charCodeAt(1);
      if (s.charCodeAt(0) === 60 && s.charCodeAt(2) === 32 && (c1 === 97 || c1 === 65)) flag = true;
      else if (s.length === 4 && c1 === 47 && s.charCodeAt(3) === 62 && (s.charCodeAt(2) === 97 || s.charCodeAt(2) === 65)) flag = false;
    } else if (nd.t === 6 && nd.bare && flag) {
      nd.t = 0;
      nd.s = nd.text;
    }
  }
  st.rawLink = flag;
}

// A link/image subtree contains a literal backtick: a text node holding
// '`' anywhere below it (recursing through nested links/images). Backticks
// inside code spans do NOT count (probe82 i=3/4, probe83 i=0).
function subtreeHasLiteralBacktick(nd) {
  for (const c of nd.ch) {
    if (c.t === 0) {
      // Only backticks from literal (unescaped, unpaired) runs trigger;
      // escaped backticks (\`) do not (doc-07).
      if (c._litBt) return true;
    } else if (c.t === 4 || c.t === 5) {
      if (subtreeHasLiteralBacktick(c)) return true;
    }
  }
  return false;
}

function subtreeHasSpan(nd) {
  if (nd.t === 2) return true;
  if (nd.t === 4 || nd.t === 5) {
    for (const c of nd.ch) if (subtreeHasSpan(c)) return true;
  }
  return false;
}

// Backtick-link suppression (probes 80-85): when a link/image whose text
// holds literal backticks is followed in the same inline list by a code
// span, emphasis delimiters strictly between the FIRST such link/image and
// the top-level node containing the LAST following code span are dead.
// Spans nested inside links count as zone ends; spans inside the trigger
// itself do not open a zone; the rule applies per list, recursively.
function applyBacktickLinkSuppression(nodes) {
  for (const nd of nodes) {
    if (nd.t === 4 || nd.t === 5) applyBacktickLinkSuppression(nd.ch);
  }
  let t = -1;
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if ((nd.t === 4 || nd.t === 5) && subtreeHasLiteralBacktick(nd)) {
      t = k;
      break;
    }
  }
  if (t === -1) return;
  let s = -1;
  for (let k = t + 1; k < nodes.length; k++) {
    if (subtreeHasSpan(nodes[k])) s = k;
  }
  if (s === -1) return;
  for (let k = t + 1; k < s; k++) {
    if (nodes[k].t === 8) nodes[k].dead = true;
  }
}

function inline(text, refmap, st) {
  const nodes = parseInline(text, refmap);
  if (st) applyRawLink(nodes, st);
  applyBacktickLinkSuppression(nodes);
  processEmphasis(nodes);
  if (nodes._hasTrims) resolveTrimmedEmails(nodes);
  return renderNodes(nodes, 0);
}

// ---------------------------------------------------------------------------
// Block parsing: line helpers
// ---------------------------------------------------------------------------

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Indent of a line in columns (tabs advance to the next multiple of 4).
function indentCols(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col = (col + 4) & ~3;
    else break;
  }
  return col;
}

// Index of the first character that is not a space or tab.
function firstNonWs(s) {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  return i;
}

// Remove up to n columns of leading indentation; a straddled tab becomes
// the remaining spaces.
function stripColumns(s, n) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < n) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      const nc = (col + 4) & ~3;
      if (nc <= n) {
        col = nc;
        i++;
      } else {
        return " ".repeat(nc - n) + s.slice(i + 1);
      }
    } else {
      break;
    }
  }
  return s.slice(i);
}

// Fence content strip: like stripColumns, except a tab that straddles the
// cut is consumed ENTIRELY (no remainder spaces). Verified by probes:
// fence indent 2 + "\tfoo" -> "foo"; indent 2 + " \tfoo" -> "foo";
// a tab starting exactly at the cut is kept ("  \tfoo" indent 2 -> "\tfoo").
function stripFence(s, n) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < n) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      col = (col + 4) & ~3;
      i++;
    } else {
      break;
    }
  }
  return s.slice(i);
}

// Like stripColumns, but the result is re-parsed later, so the remaining
// leading whitespace is expanded to spaces using the original columns:
// a tab's width depends on its original position, and a cut that lands
// mid-tab-stop would otherwise misalign every tab that follows.
function stripColumnsAligned(s, n) {
  let col = 0;
  let i = 0;
  let prefix = "";
  while (i < s.length && col < n) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      const nc = (col + 4) & ~3;
      if (nc <= n) {
        col = nc;
        i++;
      } else {
        prefix = " ".repeat(nc - n);
        col = nc;
        i++;
        break;
      }
    } else {
      break;
    }
  }
  if (col < n) return s.slice(i);
  // No early return when the cut lands on a tab stop: a tab starting at
  // the cut must still be expanded (doc-04/30: list strip of 8 columns
  // leaves "\tfoo", which marked renders as 4 spaces in fence content).
  let spaces = 0;
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 32) {
      spaces++;
      col++;
      j++;
    } else if (c === 9) {
      const nc = (col + 4) & ~3;
      spaces += nc - col;
      col = nc;
      j++;
    } else {
      break;
    }
  }
  return prefix + " ".repeat(spaces) + s.slice(j);
}

// Remove n columns from the start of a line, counting every character
// (markers count one column, tabs advance to the next stop), with the same
// aligned expansion of the remaining leading whitespace. Used for
// blockquote markers and over-indented list item content.
function stripPrefixAligned(s, n) {
  let col = 0;
  let i = 0;
  let prefix = "";
  while (i < s.length && col < n) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      const nc = (col + 4) & ~3;
      if (nc <= n) {
        col = nc;
        i++;
      } else {
        prefix = " ".repeat(nc - n);
        col = nc;
        i++;
        break;
      }
    } else {
      col++;
      i++;
    }
  }
  if (col < n) return "";
  // No early return when the cut lands on a tab stop: a tab starting at
  // the cut must still be expanded (see stripColumnsAligned).
  let spaces = 0;
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 32) {
      spaces++;
      col++;
      j++;
    } else if (c === 9) {
      const nc = (col + 4) & ~3;
      spaces += nc - col;
      col = nc;
      j++;
    } else {
      break;
    }
  }
  return prefix + " ".repeat(spaces) + s.slice(j);
}

function trimSpacesTabs(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

// ---------------------------------------------------------------------------
// Block-start matchers
// ---------------------------------------------------------------------------

// ATX heading. Returns {level, text} or null.
function matchATX(line) {
  const j = firstNonWs(line);
  if (indentCols(line) > 3) return null;
  if (line.charCodeAt(j) !== 35) return null;
  let k = j;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  const level = k - j;
  if (level > 6) return null;
  if (k < line.length && line.charCodeAt(k) !== 32 && line.charCodeAt(k) !== 9) return null;
  let content = line.slice(k);
  let a = 0;
  while (a < content.length && (content.charCodeAt(a) === 32 || content.charCodeAt(a) === 9)) a++;
  content = content.slice(a);
  let e = content.length;
  while (e > 0 && (content.charCodeAt(e - 1) === 32 || content.charCodeAt(e - 1) === 9)) e--;
  content = content.slice(0, e);
  // Strip one closing hash sequence, when preceded by whitespace.
  let h = content.length;
  while (h > 0 && content.charCodeAt(h - 1) === 35) h--;
  if (h < content.length) {
    if (h === 0) {
      content = "";
    } else if (content.charCodeAt(h - 1) === 32 || content.charCodeAt(h - 1) === 9) {
      let b = h;
      while (b > 0 && (content.charCodeAt(b - 1) === 32 || content.charCodeAt(b - 1) === 9)) b--;
      content = content.slice(0, b);
    }
  }
  return { level, text: content };
}

// Fenced code block opener. Returns {ch, len, indent, lang} or null.
function matchFence(line) {
  const j = firstNonWs(line);
  const ind = indentCols(line);
  if (ind > 3) return null;
  const c = line.charCodeAt(j);
  if (c !== 96 && c !== 126) return null;
  let k = j;
  while (k < line.length && line.charCodeAt(k) === c) k++;
  const len = k - j;
  if (len < 3) return null;
  const info = line.slice(k);
  if (c === 96 && info.indexOf("`") !== -1) return null;
  const trimmed = trimSpacesTabs(info);
  let lang = "";
  if (trimmed !== "") {
    let w = 0;
    while (w < trimmed.length && trimmed.charCodeAt(w) !== 32 && trimmed.charCodeAt(w) !== 9) w++;
    lang = trimmed.slice(0, w);
    // Backslash escapes in the info word are processed.
    if (lang.indexOf("\\") !== -1) {
      let unesc = "";
      for (let u = 0; u < lang.length; u++) {
        if (lang.charCodeAt(u) === 92 && u + 1 < lang.length && lang.charCodeAt(u + 1) < 128 && PUNCT_ASCII[lang.charCodeAt(u + 1)]) {
          unesc += lang[u + 1];
          u++;
        } else {
          unesc += lang[u];
        }
      }
      lang = unesc;
    }
  }
  return { ch: c === 96 ? "`" : "~", len, indent: ind, lang };
}

function isClosingFence(line, ch, len) {
  const j = firstNonWs(line);
  if (indentCols(line) > 3) return false;
  const c = ch.charCodeAt(0);
  let k = j;
  while (k < line.length && line.charCodeAt(k) === c) k++;
  if (k - j < len) return false;
  while (k < line.length) {
    if (line.charCodeAt(k) !== 32 && line.charCodeAt(k) !== 9) return false;
    k++;
  }
  return true;
}

// Thematic break: 3+ identical markers from {*, -, _}, spaces allowed.
function matchHR(line) {
  const j = firstNonWs(line);
  if (indentCols(line) > 3) return false;
  const c = line.charCodeAt(j);
  if (c !== 42 && c !== 45 && c !== 95) return false;
  let count = 0;
  for (let i = j; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === c) count++;
    else if (ch !== 32 && ch !== 9) return false;
  }
  return count >= 3;
}

// Blockquote marker. Returns {content} (the line after the marker plus one
// column of following whitespace, tab-aligned) or null.
function matchBlockquote(line) {
  const j = firstNonWs(line);
  const ind = indentCols(line);
  if (ind > 3) return null;
  if (line.charCodeAt(j) !== 62) return null;
  const after = line.charCodeAt(j + 1);
  const hasWs = after === 32 || after === 9 ? 1 : 0;
  return { content: stripPrefixAligned(line, ind + 1 + hasWs) };
}

// List marker. Returns {ordered, delim, marker, num, indent, contentIndent,
// content} or null. content is the item's first line after the marker.
function matchListMarker(line) {
  const j = firstNonWs(line);
  const ind = indentCols(line);
  if (ind > 3) return null;
  const c = line.charCodeAt(j);
  let ordered = false;
  let delim = 0;
  let marker = 0;
  let num = 0;
  let width = 0;
  if (c === 45 || c === 43 || c === 42) {
    marker = c;
    width = 1;
  } else if (c >= 48 && c <= 57) {
    let k = j;
    while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
    const digits = k - j;
    if (digits > 9) return null;
    const d = line.charCodeAt(k);
    if (d !== 46 && d !== 41) return null;
    ordered = true;
    delim = d;
    num = parseInt(line.slice(j, k), 10);
    width = digits + 1;
  } else {
    return null;
  }
  const after = j + width;
  if (after < line.length && line.charCodeAt(after) !== 32 && line.charCodeAt(after) !== 9) return null;
  // Whitespace columns after the marker, in absolute columns.
  let col = ind + width;
  let k = after;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) {
    if (line.charCodeAt(k) === 32) col++;
    else col = (col + 4) & ~3;
    k++;
  }
  if (k >= line.length) {
    // Empty item.
    return { ordered, delim, marker, num, indent: ind, contentIndent: ind + width + 1, content: "" };
  }
  const wsCols = col - (ind + width);
  if (wsCols <= 4) {
    return { ordered, delim, marker, num, indent: ind, contentIndent: col, content: line.slice(k) };
  }
  const contentIndent = ind + width + 1;
  return { ordered, delim, marker, num, indent: ind, contentIndent, content: stripPrefixAligned(line, contentIndent) };
}

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "base", "basefont", "blockquote", "body",
  "caption", "center", "col", "colgroup", "dd", "details", "dialog", "dir",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header",
  "hr", "html", "iframe", "legend", "li", "link", "main", "menu", "menuitem",
  "meta", "nav", "noframes", "ol", "optgroup", "option", "p", "param",
  "section", "source", "summary", "table", "tbody", "td", "tfoot", "th",
  "thead", "title", "tr", "track", "ul",
]);

// HTML block start. Returns {type, tag} or null. Types 1-6 are the CommonMark
// kinds; type 7 is a line consisting solely of one complete tag.
function matchHtmlStart(line) {
  const j = firstNonWs(line);
  if (indentCols(line) > 3) return null;
  const rest = line.slice(j);
  if (rest.charCodeAt(0) !== 60) return null;
  const lower = rest.toLowerCase();
  // Type 1: pre / script / style / textarea open tag.
  for (const tag of ["pre", "script", "style", "textarea"]) {
    if (lower.startsWith("<" + tag)) {
      const nc = lower.charCodeAt(1 + tag.length);
      if (nc === 32 || nc === 9 || nc === 62 || nc === 47 || Number.isNaN(nc)) {
        return { type: 1, tag };
      }
    }
  }
  if (rest.startsWith("<!--")) return { type: 2, tag: null };
  if (rest.startsWith("<?")) return { type: 3, tag: null };
  if (rest.startsWith("<![CDATA[")) return { type: 5, tag: null };
  const c2 = rest.charCodeAt(2);
  if (rest.charCodeAt(1) === 33 && ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122))) {
    return { type: 4, tag: null };
  }
  // Type 6: block tag open or close, followed by space/EOL/>/attrs.
  let p = 1;
  if (rest.charCodeAt(p) === 47) p++;
  const nameStart = p;
  if (p < rest.length) {
    const nc = rest.charCodeAt(p);
    if ((nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122)) {
      p++;
      while (p < rest.length && rest.charCodeAt(p) < 128 && TAGNAME_ASCII[rest.charCodeAt(p)]) p++;
      const name = rest.slice(nameStart, p).toLowerCase();
      if (BLOCK_TAGS.has(name)) {
        const dc = rest.charCodeAt(p);
        if (dc === 32 || dc === 9 || dc === 62 || dc === 47 || Number.isNaN(dc)) {
          return { type: 6, tag: name };
        }
      }
    }
  }
  // Type 7: the line is one complete tag and nothing else.
  const tagEnd = parseHtmlTag(rest, 0);
  if (tagEnd !== -1) {
    let q = tagEnd;
    while (q < rest.length && (rest.charCodeAt(q) === 32 || rest.charCodeAt(q) === 9)) q++;
    if (q >= rest.length) return { type: 7, tag: null };
  }
  return null;
}

// Setext underline. Returns {level} or null.
function matchSetext(line) {
  const j = firstNonWs(line);
  if (indentCols(line) > 3) return null;
  const c = line.charCodeAt(j);
  if (c !== 61 && c !== 45) return null;
  let k = j;
  while (k < line.length && line.charCodeAt(k) === c) k++;
  while (k < line.length) {
    if (line.charCodeAt(k) !== 32 && line.charCodeAt(k) !== 9) return null;
    k++;
  }
  return { level: c === 61 ? 1 : 2 };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

// Split a table line into cells on unescaped '|', dropping one empty edge
// cell per leading/trailing pipe. Cells are trimmed of spaces/tabs.
function splitTableLine(line) {
  const start = firstNonWs(line);
  let s = line.slice(start);
  let e = s.length;
  while (e > 0 && (s.charCodeAt(e - 1) === 32 || s.charCodeAt(e - 1) === 9)) e--;
  s = s.slice(0, e);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 92 && i + 1 < s.length) {
      if (s.charCodeAt(i + 1) === 124) {
        cur += "|";
        i++;
        continue;
      }
      cur += s[i] + s[i + 1];
      i++;
      continue;
    }
    if (ch === 124) {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += s[i];
  }
  cells.push(cur);
  if (cells.length > 0 && s.charCodeAt(0) === 124) cells.shift();
  if (cells.length > 0 && s.charCodeAt(s.length - 1) === 124) cells.pop();
  for (let i = 0; i < cells.length; i++) cells[i] = trimSpacesTabs(cells[i]);
  return cells;
}

function parseDelimiterCells(line) {
  // Fast reject (exact): a delimiter row's cells may only contain ':'
  // and '-', so the whole line may only contain '-', ':', '|', spaces
  // and tabs (any backslash or other char lands in a cell and invalidates
  // it), must contain '-', and must be indented at most 3 columns.
  // This runs on every paragraph continuation line; most fail within
  // a few characters, avoiding the split + cell validation below.
  let col = 0;
  let hasDash = false;
  let seenNonWs = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 45) {
      hasDash = true;
      seenNonWs = true;
    } else if (c === 58 || c === 124) {
      seenNonWs = true;
    } else if (c === 32) {
      if (!seenNonWs && ++col > 3) return null;
    } else if (c === 9) {
      if (!seenNonWs) {
        col += 4 - (col % 4);
        if (col > 3) return null;
      }
    } else {
      return null;
    }
  }
  if (!hasDash) return null;
  if (indentCols(line) > 3) return null;
  const cells = splitTableLine(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell;
    let a = 0;
    let b = t.length;
    let left = false;
    let right = false;
    if (a < b && t.charCodeAt(a) === 58) {
      left = true;
      a++;
    }
    if (b > a && t.charCodeAt(b - 1) === 58) {
      right = true;
      b--;
    }
    if (b - a < 1) return null;
    for (let i = a; i < b; i++) {
      if (t.charCodeAt(i) !== 45) return null;
    }
    aligns.push(left && right ? "center" : left ? "left" : right ? "right" : null);
  }
  return { cells, aligns };
}

function hasUnescapedPipe(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 92) {
      i++;
      continue;
    }
    if (c === 124) return true;
  }
  return false;
}

// If `line` is a valid delimiter row for a table whose header is
// `headerLine`, return {aligns, headerCells}; otherwise null.
function tryTableDelim(line, headerLine) {
  const delim = parseDelimiterCells(line);
  if (!delim) return null;
  const headerCells = splitTableLine(headerLine);
  if (delim.cells.length !== headerCells.length) return null;
  if (!hasUnescapedPipe(headerLine) && line.indexOf("|") === -1) return null;
  return { aligns: delim.aligns, headerCells };
}

// ---------------------------------------------------------------------------
// Link reference definitions (block level)
// ---------------------------------------------------------------------------

// Parse a definition title starting at chunk[p] (a quote or '(').
// Returns {title, end} (end just past the closing quote/paren) or null.
// A blank line inside the title fails the parse.
function parseDefTitle(chunk, p, qc) {
  const n = chunk.length;
  let q = p + 1;
  let out = "";
  if (qc === 40) {
    let depth = 1;
    while (q < n) {
      const c = chunk.charCodeAt(q);
      if (c === 10) {
        let r = q + 1;
        while (r < n && (chunk.charCodeAt(r) === 32 || chunk.charCodeAt(r) === 9)) r++;
        if (r >= n || chunk.charCodeAt(r) === 10) return null;
      }
      if (c === 92 && q + 1 < n && chunk.charCodeAt(q + 1) < 128 && PUNCT_ASCII[chunk.charCodeAt(q + 1)]) {
        out += chunk[q + 1];
        q += 2;
        continue;
      }
      if (c === 40) {
        depth++;
        out += chunk[q];
        q++;
        continue;
      }
      if (c === 41) {
        depth--;
        if (depth === 0) return { title: out, end: q + 1 };
        out += chunk[q];
        q++;
        continue;
      }
      out += chunk[q];
      q++;
    }
    return null;
  }
  while (q < n) {
    const c = chunk.charCodeAt(q);
    if (c === 10) {
      let r = q + 1;
      while (r < n && (chunk.charCodeAt(r) === 32 || chunk.charCodeAt(r) === 9)) r++;
      if (r >= n || chunk.charCodeAt(r) === 10) return null;
    }
    if (c === qc) return { title: out, end: q + 1 };
    if (c === 92 && q + 1 < n && chunk.charCodeAt(q + 1) < 128 && PUNCT_ASCII[chunk.charCodeAt(q + 1)]) {
      out += chunk[q + 1];
      q += 2;
      continue;
    }
    out += chunk[q];
    q++;
  }
  return null;
}

// Parse a definition starting at lines[i]. On success registers into refmap
// and returns the number of lines consumed; on failure returns 0.
function parseDef(lines, i, refmap) {
  const chunk = lines.slice(i, i + 10).join("\n");
  const n = chunk.length;
  let p = 0;
  while (p < n && (chunk.charCodeAt(p) === 32 || chunk.charCodeAt(p) === 9)) p++;
  if (chunk.charCodeAt(p) !== 91) return 0;
  // Label: ends at the first unescaped ']' (no nesting), escapes, no
  // blank line, at most 999 chars.
  let q = p + 1;
  let labelEnd = -1;
  while (q < n) {
    const c = chunk.charCodeAt(q);
    if (c === 92) {
      if (q + 1 >= n) return 0;
      q += 2;
      continue;
    }
    if (c === 93) {
      labelEnd = q;
      break;
    }
    if (c === 91) return 0;
    if (c === 10) {
      let r = q + 1;
      while (r < n && (chunk.charCodeAt(r) === 32 || chunk.charCodeAt(r) === 9)) r++;
      if (r >= n || chunk.charCodeAt(r) === 10) return 0;
    }
    q++;
  }
  if (labelEnd === -1) return 0;
  const label = chunk.slice(p + 1, labelEnd);
  if (label.length > 999) return 0;
  const norm = normalizeLabel(label);
  if (norm === "") return 0;
  q = labelEnd + 1;
  if (chunk.charCodeAt(q) !== 58) return 0;
  q++;
  // Skip whitespace/newlines, but never across a blank line.
  const skipDefWs = (pos) => {
    while (pos < n) {
      while (pos < n && (chunk.charCodeAt(pos) === 32 || chunk.charCodeAt(pos) === 9)) pos++;
      if (chunk.charCodeAt(pos) !== 10) break;
      let r = pos + 1;
      while (r < n && (chunk.charCodeAt(r) === 32 || chunk.charCodeAt(r) === 9)) r++;
      if (r >= n || chunk.charCodeAt(r) === 10) break;
      pos = r;
    }
    return pos;
  };
  q = skipDefWs(q);
  // Destination.
  let dest = "";
  if (chunk.charCodeAt(q) === 60) {
    let out = "";
    q++;
    let closed = false;
    while (q < n) {
      const c = chunk.charCodeAt(q);
      if (c === 62) {
        closed = true;
        q++;
        break;
      }
      if (c === 60 || c === 10 || c === 127 || (c < 32 && c !== 9)) return 0;
      if (c === 92 && q + 1 < n && chunk.charCodeAt(q + 1) < 128 && PUNCT_ASCII[chunk.charCodeAt(q + 1)]) {
        out += chunk[q + 1];
        q += 2;
        continue;
      }
      out += chunk[q];
      q++;
    }
    if (!closed) return 0;
    dest = out;
  } else {
    let out = "";
    let depth2 = 0;
    const start = q;
    while (q < n) {
      const c = chunk.charCodeAt(q);
      if (c <= 32 || c === 127) break;
      if (c === 40) {
        depth2++;
        out += chunk[q];
        q++;
        continue;
      }
      if (c === 41) {
        if (depth2 === 0) break;
        depth2--;
        out += chunk[q];
        q++;
        continue;
      }
      if (c === 92 && q + 1 < n && chunk.charCodeAt(q + 1) < 128 && PUNCT_ASCII[chunk.charCodeAt(q + 1)]) {
        out += chunk[q + 1];
        q += 2;
        continue;
      }
      out += chunk[q];
      q++;
    }
    if (q === start) return 0;
    dest = out;
  }
  // Optional title on the same or a following line. A title requires
  // whitespace between it and the destination. If a title candidate on a
  // following line fails, the definition still succeeds without a title.
  const destEnd = q;
  q = skipDefWs(q);
  let title = null;
  const qc = chunk.charCodeAt(q);
  const hadWs = q > destEnd;
  if (hadWs && (qc === 34 || qc === 39 || qc === 40)) {
    const t = parseDefTitle(chunk, q, qc);
    let ok = false;
    if (t) {
      let e = t.end;
      while (e < n && (chunk.charCodeAt(e) === 32 || chunk.charCodeAt(e) === 9)) e++;
      if (e >= n || chunk.charCodeAt(e) === 10) {
        title = t.title;
        q = e;
        ok = true;
      }
    }
    if (!ok) {
      let multi = false;
      for (let m = destEnd; m < q; m++) {
        if (chunk.charCodeAt(m) === 10) {
          multi = true;
          break;
        }
      }
      if (!multi) return 0;
    }
  }
  if (title === null) {
    // No title: the definition must end on the destination's own line.
    q = destEnd;
    while (q < n && (chunk.charCodeAt(q) === 32 || chunk.charCodeAt(q) === 9)) q++;
    if (q < n && chunk.charCodeAt(q) !== 10) return 0;
  }
  // Lines consumed: newlines before the end position, plus one.
  let consumed = 1;
  for (let i2 = 0; i2 < q; i2++) {
    if (chunk.charCodeAt(i2) === 10) consumed++;
  }
  if (!refmap.has(norm)) refmap.set(norm, { href: dest, title });
  return consumed;
}

// ---------------------------------------------------------------------------
// Block parsing: the main loop and container collectors
// ---------------------------------------------------------------------------

function deepestParagraph(blocks) {
  if (blocks.length === 0) return null;
  let b = blocks[blocks.length - 1];
  while (true) {
    if (b.k === "quote") {
      if (b.children.length === 0) return null;
      b = b.children[b.children.length - 1];
    } else if (b.k === "list") {
      if (b.items.length === 0) return null;
      const last = b.items[b.items.length - 1];
      if (last.length === 0) return null;
      b = last[last.length - 1];
    } else {
      break;
    }
  }
  return b.k === "para" ? b : null;
}

// Like deepestParagraph, but also reports whether the paragraph is a
// direct (top-level) block of `blocks` rather than nested in a container,
// and whether its immediate container is a list item (baseInList is the
// flag for `blocks` itself; descending into a quote resets it to false,
// descending into a list sets it to true).
function deepestParagraphInfo(blocks, baseInList) {
  if (blocks.length === 0) return null;
  let b = blocks[blocks.length - 1];
  let direct = true;
  let inList = !!baseInList;
  while (true) {
    if (b.k === "quote") {
      if (b.children.length === 0) return null;
      direct = false;
      inList = false;
      b = b.children[b.children.length - 1];
    } else if (b.k === "list") {
      if (b.items.length === 0) return null;
      const last = b.items[b.items.length - 1];
      if (last.length === 0) return null;
      direct = false;
      inList = true;
      b = last[last.length - 1];
    } else {
      break;
    }
  }
  return b.k === "para" ? { para: b, direct, inList } : null;
}

// Whether a line starts a block that interrupts an open paragraph.
// Inside a list item (inItem), ANY list marker interrupts, including
// ordered lists with any start number and empty items; elsewhere only
// non-empty bullets and ordered lists starting at 1 interrupt.
function interruptsParagraph(line, inItem) {
  if (matchATX(line)) return true;
  if (matchFence(line)) return true;
  if (matchHR(line)) return true;
  if (matchBlockquote(line)) return true;
  const mk = matchListMarker(line);
  if (mk && (inItem || (mk.content !== "" && (!mk.ordered || mk.num === 1)))) return true;
  const h = matchHtmlStart(line);
  if (h && h.type <= 6) return true;
  return false;
}

// Whether a line ends a table body (becomes a new block instead of a row).
function tableBodyInterrupts(line, inItem) {
  if (matchATX(line) || matchFence(line) || matchHR(line) || matchBlockquote(line)) return true;
  const mk = matchListMarker(line);
  if (mk && (inItem || (mk.content !== "" && (!mk.ordered || mk.num === 1)))) return true;
  const h = matchHtmlStart(line);
  if (h && h.type <= 6) return true;
  if (indentCols(line) >= 4) return true;
  return false;
}

// Collect a paragraph starting at lines[i], handling setext headings and
// table conversion. Returns {blocks, next}.
function collectParagraph(lines, i, ctx, lazySet) {
  const plines = [lines[i]];
  let j = i + 1;
  let prevDeep = false;
  while (j < lines.length) {
    const ln = lines[j];
    if (isBlankLine(ln)) {
      // A whitespace-only last line is absorbed into the paragraph when
      // the input does not end with a newline (nested content never does).
      if (ln.length > 0 && j === lines.length - 1 && !ctx.srcEndsWithNewline) {
        plines.push(ln);
        j++;
      }
      break;
    }
    const se = matchSetext(ln);
    const isLazy = lazySet && lazySet.has(j);
    if (se && !isLazy) {
      const raw = plines.join("\n");
      const text = raw.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
      return { blocks: [{ k: "head", level: se.level, text }], next: j + 1 };
    }
    const lastLine = plines[plines.length - 1];
    const tab = tryTableDelim(ln, lastLine);
    if (tab) {
      const blocks = [];
      if (plines.length > 1) {
        blocks.push({ k: "para", text: plines.slice(0, -1).join("\n") });
      }
      const rows = [];
      let k = j + 1;
      while (k < lines.length) {
        const rl = lines[k];
        if (rl === "") break;
        if (isBlankLine(rl)) {
          // A whitespace-only line of 0-3 spaces + exactly one tab is an
          // empty table row (probes 41-44), provided it is newline
          // terminated: at the document root the last line needs a
          // trailing newline; nested content is treated as terminated.
          const tabRow = rl.charCodeAt(rl.length - 1) === 9 && rl.length <= 4 && rl.indexOf("\t") === rl.length - 1;
          if (tabRow && (k < lines.length - 1 || ctx.srcEndsWithNewline || !ctx.isDocRoot)) {
            rows.push(splitTableLine(rl));
            k++;
            continue;
          }
          break;
        }
        if (tableBodyInterrupts(rl, ctx.inItem)) break;
        rows.push(splitTableLine(rl));
        k++;
      }
      blocks.push({ k: "table", aligns: tab.aligns, header: tab.headerCells, rows });
      return { blocks, next: k };
    }
    if (!isLazy && interruptsParagraph(ln, ctx.inItem)) break;
    let content = ln;
    let deep = false;
    if (ctx.inList && indentCols(ln) >= 4) {
      content = stripColumns(ln, 4);
      deep = true;
    }
    if (prevDeep && !deep) plines.push("");
    plines.push(content);
    prevDeep = deep;
    j++;
  }
  return { blocks: [{ k: "para", text: plines.join("\n") }], next: j };
}

// Collect a fenced code block starting at lines[i].
function collectFence(lines, i, fence, ctx) {
  const content = [];
  // Tilde fences never strip content indentation, in any context;
  // backtick fences strip up to the opening fence's indent (probes
  // 28/30/31/32/46/47). The earlier quoteStrip theory was wrong: the
  // discriminator is the fence character, not the container.
  const strip = fence.ch === "~" ? 0 : fence.indent;
  let j = i + 1;
  let closed = false;
  while (j < lines.length) {
    if (isClosingFence(lines[j], fence.ch, fence.len)) {
      j++;
      closed = true;
      break;
    }
    content.push(stripFence(lines[j], strip));
    j++;
  }
  // Exactly one trailing empty content line is dropped.
  if (content.length > 0 && content[content.length - 1] === "") content.pop();
  const text = content.join("\n") + (content.length > 0 ? "\n" : "");
  return { block: { k: "code", lang: fence.lang, text, fenced: true, closed }, next: j };
}

// Collect an indented code block starting at lines[i]. Blank lines keep
// their 4-column-stripped content; only trailing blank lines are dropped.
function collectCode(lines, i) {
  const raw = [];
  let j = i;
  let trailingBlankCount = 0;
  while (j < lines.length) {
    const ln = lines[j];
    if (isBlankLine(ln)) {
      raw.push(stripColumns(ln, 4));
      trailingBlankCount++;
      j++;
      continue;
    }
    if (indentCols(ln) >= 4) {
      raw.push(stripColumns(ln, 4));
      trailingBlankCount = 0;
      j++;
      continue;
    }
    break;
  }
  raw.length -= trailingBlankCount;
  const text = raw.join("\n") + (raw.length > 0 ? "\n" : "");
  return { block: { k: "code", lang: "", text }, next: j - trailingBlankCount };
}

// Whether a type-1 HTML block's line contains the matching close tag.
function hasCloseTag(line, tag) {
  const lower = line.toLowerCase();
  const needle = "</" + tag;
  let idx = 0;
  while (true) {
    const found = lower.indexOf(needle, idx);
    if (found === -1) return false;
    const nc = lower.charCodeAt(found + needle.length);
    if (nc === 32 || nc === 9 || nc === 62 || nc === 47 || Number.isNaN(nc)) return true;
    idx = found + 1;
  }
}

// Collect an HTML block starting at lines[i].
function collectHtml(lines, i, info, ctx) {
  let endLine;
  let kind;
  let droppedBlanks = false;
  if (info.type <= 5) {
    endLine = lines.length - 1;
    kind = "eof";
    for (let j = i; j < lines.length; j++) {
      const ln = lines[j];
      let hit = false;
      if (info.type === 1) hit = hasCloseTag(ln, info.tag);
      else if (info.type === 2) hit = ln.indexOf("-->") !== -1;
      else if (info.type === 3) hit = ln.indexOf("?>") !== -1;
      else if (info.type === 4) hit = ln.indexOf(">") !== -1;
      else hit = ln.indexOf("]]>") !== -1;
      if (hit) {
        endLine = j;
        kind = "term";
        break;
      }
    }
    if (kind === "eof") {
      // Unterminated at EOF: trailing blank lines are dropped from the
      // block and no trailing newline is emitted (probes 34/35).
      while (endLine > i && isBlankLine(lines[endLine])) {
        endLine--;
        droppedBlanks = true;
      }
    }
  } else {
    endLine = lines.length - 1;
    kind = "eof";
    for (let j = i + 1; j < lines.length; j++) {
      if (isBlankLine(lines[j])) {
        endLine = j - 1;
        kind = "blank";
        break;
      }
    }
  }
  let trailing = false;
  if (kind === "term") {
    // A whitespace-only next line still yields the trailing newline; only
    // a truly empty next line suppresses it (probe 33).
    if (endLine + 1 < lines.length) trailing = lines[endLine + 1] !== "";
    else trailing = ctx.isDocRoot && ctx.srcEndsWithNewline;
  } else if (kind === "eof") {
    trailing = ctx.isDocRoot && ctx.srcEndsWithNewline && !droppedBlanks;
  }
  const text = lines.slice(i, endLine + 1).join("\n") + (trailing ? "\n" : "");
  const next = kind === "blank" ? endLine + 1 : endLine + 1;
  return { block: { k: "html", text }, next };
}

// Collect a blockquote starting at lines[i]. A raw blank line splits the
// quote. Lazy continuation lines join an open paragraph: with 4 columns
// stripped when the paragraph sits directly in the quote and the line is
// indented 4+, and a lazy setext underline following another lazy line is
// re-indented to 4 spaces. Lazy lines are flagged so they never act as
// setext underlines when the collected content is parsed.
function collectQuote(lines, i, ctx) {
  const collected = [];
  const lazySet = new Set();
  let prevLazy = false;
  let j = i;
  while (j < lines.length) {
    const ln = lines[j];
    const qm = matchBlockquote(ln);
    if (qm) {
      collected.push(qm.content);
      prevLazy = false;
      j++;
      continue;
    }
    if (isBlankLine(ln)) break;
    if (collected.length > 0 && isBlankLine(collected[collected.length - 1])) break;
    const probe = parseRange(collected, { refmap: ctx.refmap, inList: ctx.inList, inItem: false, isDocRoot: false, srcEndsWithNewline: false, quoteStrip: true }, lazySet);
    const info = deepestParagraphInfo(probe.blocks, false);
    if (!info) break;
    if (interruptsParagraph(ln, info.inList)) break;
    let text = ln;
    if (info.direct && indentCols(ln) >= 4) text = stripColumns(ln, 4);
    const se = matchSetext(text);
    if (prevLazy && se && se.level === 1) text = "    " + text.replace(/^[ \t]+/, "");
    lazySet.add(collected.length);
    collected.push(text);
    prevLazy = true;
    j++;
  }
  const inner = parseRange(collected, { refmap: ctx.refmap, inList: ctx.inList, inItem: false, isDocRoot: false, srcEndsWithNewline: false, quoteStrip: true }, lazySet);
  return { block: { k: "quote", children: inner.blocks }, next: j };
}

// Collect a list starting at lines[i] with its first marker.
function collectList(lines, i, firstMarker, ctx) {
  const listIndent = firstMarker.indent;
  const ordered = firstMarker.ordered;
  const markerKey = ordered ? firstMarker.delim : firstMarker.marker;
  const items = [];
  let loose = false;
  let cur = { lines: [], contentIndent: firstMarker.contentIndent, lazy: new Set() };
  if (firstMarker.content !== "") cur.lines.push(firstMarker.content);
  let curContentIndent = firstMarker.contentIndent;
  let pendingBlanks = 0;
  let j = i + 1;
  while (j < lines.length) {
    const ln = lines[j];
    if (isBlankLine(ln)) {
      pendingBlanks++;
      j++;
      continue;
    }
    const ind = indentCols(ln);
    if (ind >= curContentIndent) {
      if (pendingBlanks > 0 && cur.lines.length === 0) break;
      for (let b = 0; b < pendingBlanks; b++) cur.lines.push("");
      pendingBlanks = 0;
      cur.lines.push(stripColumnsAligned(ln, curContentIndent));
      j++;
      continue;
    }
    // A low-indent line is absorbed verbatim into an open fence inside the
    // item once the fence already holds non-blank content (probes 39/40);
    // the first content line must still satisfy the container indent.
    // This check precedes the HR/new-item checks: inside an established
    // fence, marker- and HR-shaped lines are content, not structure.
    const probe = parseRange(cur.lines, { refmap: ctx.refmap, inList: true, inItem: true, isDocRoot: false, srcEndsWithNewline: false, quoteStrip: false }, cur.lazy);
    const lastBlock = probe.blocks[probe.blocks.length - 1];
    if (lastBlock && lastBlock.k === "code" && lastBlock.fenced && !lastBlock.closed && /\S/.test(lastBlock.text)) {
      for (let b = 0; b < pendingBlanks; b++) cur.lines.push("");
      pendingBlanks = 0;
      cur.lines.push(ln);
      j++;
      continue;
    }
    if (matchHR(ln)) break;
    const mk = matchListMarker(ln);
    if (mk && mk.indent <= listIndent + 3 && mk.indent < curContentIndent) {
      const sameType = ordered ? mk.ordered && mk.delim === markerKey : !mk.ordered && mk.marker === markerKey;
      if (!sameType) break;
      if (pendingBlanks > 0) loose = true;
      pendingBlanks = 0;
      items.push(cur);
      cur = { lines: [], contentIndent: mk.contentIndent, lazy: new Set() };
      if (mk.content !== "") cur.lines.push(mk.content);
      curContentIndent = mk.contentIndent;
      j++;
      continue;
    }
    if (pendingBlanks > 0) break;
    if (cur.lines.length > 0 && isBlankLine(cur.lines[cur.lines.length - 1])) break;
    const lastPara = deepestParagraphInfo(probe.blocks, true);
    if (!lastPara) break;
    if (interruptsParagraph(ln, lastPara.inList)) break;
    cur.lazy.add(cur.lines.length);
    cur.lines.push(ln);
    j++;
  }
  items.push(cur);
  const next = j - pendingBlanks;
  const parsedItems = items.map((it) =>
    parseRange(it.lines, { refmap: ctx.refmap, inList: true, inItem: true, isDocRoot: false, srcEndsWithNewline: false, quoteStrip: false }, it.lazy)
  );
  for (const p of parsedItems) {
    if (p.sawBlank) loose = true;
  }
  return {
    block: {
      k: "list",
      ordered,
      start: ordered ? firstMarker.num : null,
      tight: !loose,
      items: parsedItems.map((p) => p.blocks),
    },
    next,
  };
}

// Parse a run of lines into blocks. Returns {blocks, sawBlank} where
// sawBlank reports a blank line between two blocks (list looseness).
function parseRange(lines, ctx, lazySet) {
  const blocks = [];
  let blankPending = false;
  let sawBlank = false;
  let i = 0;
  const startBlock = () => {
    if (blankPending && blocks.length > 0) sawBlank = true;
    blankPending = false;
  };
  while (i < lines.length) {
    const ln = lines[i];
    if (isBlankLine(ln)) {
      blankPending = true;
      i++;
      continue;
    }
    const j = firstNonWs(ln);
    if (indentCols(ln) <= 3 && ln.charCodeAt(j) === 91) {
      const consumed = parseDef(lines, i, ctx.refmap);
      if (consumed > 0) {
        if (blankPending && blocks.length > 0) sawBlank = true;
        blankPending = false;
        i += consumed;
        continue;
      }
    }
    const atx = matchATX(ln);
    if (atx) {
      startBlock();
      blocks.push({ k: "head", level: atx.level, text: atx.text });
      i++;
      continue;
    }
    const fence = matchFence(ln);
    if (fence) {
      startBlock();
      const res = collectFence(lines, i, fence, ctx);
      blocks.push(res.block);
      i = res.next;
      continue;
    }
    const html = matchHtmlStart(ln);
    if (html) {
      startBlock();
      const res = collectHtml(lines, i, html, ctx);
      blocks.push(res.block);
      i = res.next;
      continue;
    }
    if (matchBlockquote(ln)) {
      startBlock();
      const res = collectQuote(lines, i, ctx);
      blocks.push(res.block);
      i = res.next;
      continue;
    }
    if (matchHR(ln)) {
      startBlock();
      blocks.push({ k: "hr" });
      i++;
      continue;
    }
    const mk = matchListMarker(ln);
    if (mk) {
      startBlock();
      const res = collectList(lines, i, mk, ctx);
      blocks.push(res.block);
      i = res.next;
      continue;
    }
    if (indentCols(ln) >= 4) {
      startBlock();
      const res = collectCode(lines, i);
      blocks.push(res.block);
      i = res.next;
      continue;
    }
    startBlock();
    const res = collectParagraph(lines, i, ctx, lazySet);
    for (const b of res.blocks) blocks.push(b);
    i = res.next;
  }
  return { blocks, sawBlank };
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderBlocks(blocks, refmap, bare, st) {
  let out = "";
  for (const b of blocks) {
    switch (b.k) {
      case "para": {
        const inner = inline(b.text, refmap, st);
        const cb = b.task
          ? b.taskChecked
            ? '<input checked="" disabled="" type="checkbox"> '
            : '<input disabled="" type="checkbox"> '
          : "";
        out += bare ? cb + inner : "<p>" + cb + inner + "</p>\n";
        break;
      }
      case "head":
        out += "<h" + b.level + ">" + inline(b.text, refmap, st) + "</h" + b.level + ">\n";
        break;
      case "code":
        out += "<pre><code" + (b.lang !== "" ? ' class="language-' + b.lang + '"' : "") + ">" + escapeText(b.text) + "</code></pre>\n";
        break;
      case "html":
        out += b.text;
        break;
      case "hr":
        out += "<hr>\n";
        break;
      case "quote":
        out += "<blockquote>\n" + renderBlocks(b.children, refmap, false, st) + "</blockquote>\n";
        break;
      case "list": {
        if (b.ordered) {
          out += b.start !== 1 ? '<ol start="' + b.start + '">\n' : "<ol>\n";
        } else {
          out += "<ul>\n";
        }
        for (const itemBlocks of b.items) {
          out += "<li>" + renderItem(itemBlocks, refmap, b.tight, st) + "</li>\n";
        }
        out += b.ordered ? "</ol>\n" : "</ul>\n";
        break;
      }
      case "table": {
        out += "<table>\n<thead>\n<tr>\n";
        for (let ci = 0; ci < b.header.length; ci++) {
          const al = b.aligns[ci];
          out += "<th" + (al ? ' align="' + al + '"' : "") + ">" + inline(b.header[ci], refmap, st) + "</th>\n";
        }
        out += "</tr>\n</thead>\n";
        if (b.rows.length > 0) {
          out += "<tbody>";
          for (const row of b.rows) {
            out += "<tr>\n";
            for (let ci = 0; ci < b.header.length; ci++) {
              const al = b.aligns[ci];
              const cell = ci < row.length ? row[ci] : "";
              out += "<td" + (al ? ' align="' + al + '"' : "") + ">" + inline(cell, refmap, st) + "</td>\n";
            }
            out += "</tr>\n";
          }
          out += "</tbody>";
        }
        out += "</table>\n";
        break;
      }
    }
  }
  return out;
}

function renderItem(blocks, refmap, tight, st) {
  let bs = blocks;
  if (blocks.length > 0 && blocks[0].k === "para") {
    const text = blocks[0].text;
    if (text.length >= 4 && text.charCodeAt(0) === 91 && text.charCodeAt(2) === 93) {
      const mark = text.charCodeAt(1);
      if ((mark === 32 || mark === 120 || mark === 88) && (text.charCodeAt(3) === 32 || text.charCodeAt(3) === 9)) {
        let e = 3;
        while (e < text.length && (text.charCodeAt(e) === 32 || text.charCodeAt(e) === 9)) e++;
        bs = blocks.slice();
        bs[0] = { k: "para", text: text.slice(e), task: true, taskChecked: mark === 120 || mark === 88 };
      }
    }
  }
  return renderBlocks(bs, refmap, tight, st);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, "\n");
  if (src === "") return "";
  const lines = src.split("\n");
  const endsWithNl = src.endsWith("\n");
  if (endsWithNl) lines.pop();
  const refmap = new Map();
  const ctx = { refmap, inList: false, inItem: false, isDocRoot: true, srcEndsWithNewline: endsWithNl, quoteStrip: false };
  const { blocks } = parseRange(lines, ctx);
  return renderBlocks(blocks, refmap, false, { rawLink: false });
}

export default parse;
