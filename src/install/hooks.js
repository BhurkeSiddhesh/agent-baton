import { canonicalJson } from '../lib/util.js';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

/** A hook entry baton wrote: its JSON mentions baton and its guard command. */
export function isBatonEntry(el) {
  const s = JSON.stringify(el);
  return /baton/.test(s) && /\bguard\b/.test(s);
}

function mergeArray(existing, incoming) {
  const out = [...existing];
  for (const el of incoming) {
    let idx = out.findIndex((x) => same(x, el));
    if (idx < 0 && isBatonEntry(el)) idx = out.findIndex((x) => isBatonEntry(x));
    if (idx >= 0) out[idx] = el;
    else out.push(el);
  }
  // older baton entries that did not match anything incoming are stale duplicates
  const seen = new Set();
  return out.filter((x) => {
    if (!isBatonEntry(x)) return true;
    const k = canonicalJson(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return incoming.some((el) => same(el, x));
  });
}

/**
 * Merge `incoming` into `existing` without clobbering: objects merge recursively, arrays are unioned (a previous baton hook entry
 * is replaced in place), scalars already present are kept.
 */
export function mergeJson(existing, incoming) {
  if (Array.isArray(existing) && Array.isArray(incoming)) return mergeArray(existing, incoming);
  if (isObj(existing) && isObj(incoming)) {
    const out = { ...existing };
    for (const k of Object.keys(incoming)) out[k] = k in existing ? mergeJson(existing[k], incoming[k]) : incoming[k];
    return out;
  }
  return existing === undefined ? incoming : existing;
}

/** Remove what mergeJson added: array elements equal to the snippet's (or baton hook entries); empty containers are dropped. */
export function unmergeJson(existing, incoming) {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return existing.filter((x) => !incoming.some((el) => same(el, x)) && !(isBatonEntry(x) && incoming.some(isBatonEntry)));
  }
  if (isObj(existing) && isObj(incoming)) {
    const out = { ...existing };
    for (const k of Object.keys(incoming)) {
      if (!(k in out)) continue;
      const next = unmergeJson(out[k], incoming[k]);
      const empty = (Array.isArray(next) && !next.length) || (isObj(next) && !Object.keys(next).length);
      if (empty && (Array.isArray(incoming[k]) || isObj(incoming[k]))) delete out[k];
      else out[k] = next;
    }
    return out;
  }
  return existing;
}

/** Indent unit of a JSON text (tab, or the number of spaces of the first indented line); default 2 spaces. */
export function detectIndent(text) {
  const m = /^([ \t]+)\S/m.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return 2;
  return m[1].startsWith('\t') ? '\t' : m[1].length;
}

/** Serialise like the original file: same indent, EOL and trailing newline. */
export function stringifyLike(original, value) {
  const eol = original && original.includes('\r\n') ? '\r\n' : '\n';
  const trailing = original ? /\n$/.test(original) : true;
  let text = JSON.stringify(value, null, original ? detectIndent(original) : 2);
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return trailing ? text + eol : text;
}

/** Does a Claude Code settings object contain the baton guard hook? */
export function hasGuardHook(settings) {
  const pre = settings?.hooks?.PreToolUse;
  return Array.isArray(pre) && pre.some(isBatonEntry);
}
