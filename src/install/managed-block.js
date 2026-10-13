import { sha256 } from '../lib/util.js';

export const BLOCK_VERSION = 1;

/** Comment styles: `html` for Markdown-ish files, `hash` for gitignore-like files. */
const STYLES = {
  html: { begin: (v) => `<!-- baton:begin v${v} -->`, end: '<!-- baton:end -->', beginRe: /<!-- baton:begin v\d+ -->/, endRe: /<!-- baton:end -->/ },
  hash: { begin: (v) => `# baton:begin v${v}`, end: '# baton:end', beginRe: /^# baton:begin v\d+[ \t]*$/m, endRe: /^# baton:end[ \t]*$/m },
};

export const lf = (s) => String(s).replace(/\r\n/g, '\n');

/** The full managed block (markers included), LF endings, no trailing newline. */
export function blockText(body, style = 'html') {
  const s = STYLES[style];
  return `${s.begin(BLOCK_VERSION)}\n${lf(body).replace(/^\n+|\s+$/g, '')}\n${s.end}`;
}

/** Hash of a block, independent of the line endings the file uses. */
export function blockHash(block) {
  return sha256(lf(block));
}

/**
 * Locate the block in a file. Returns {start, end} (end exclusive, covers the end marker), null when absent,
 * or {malformed: true} when only one marker exists.
 */
export function findBlock(text, style = 'html') {
  const s = STYLES[style];
  const b = s.beginRe.exec(text);
  if (!b) return s.endRe.test(text) ? { malformed: true } : null;
  const rest = text.slice(b.index + b[0].length);
  const e = s.endRe.exec(rest);
  if (!e) return { malformed: true };
  return { start: b.index, end: b.index + b[0].length + e.index + e[0].length };
}

export function extractBlock(text, style = 'html') {
  const loc = findBlock(text, style);
  return loc && !loc.malformed ? lf(text.slice(loc.start, loc.end)) : null;
}

/**
 * Insert or replace the block. Everything outside it is preserved byte for byte; the file's own EOL style is used for the block.
 * @returns {{text: string, action: 'create'|'append'|'replace'|'unchanged'|'malformed'}}
 */
export function applyBlock(existing, body, style = 'html') {
  const block = blockText(body, style);
  if (existing == null) return { text: `${block}\n`, action: 'create' };
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const mine = eol === '\n' ? block : block.replace(/\n/g, eol);
  const loc = findBlock(existing, style);
  if (loc?.malformed) return { text: existing, action: 'malformed' };
  if (loc) {
    const next = existing.slice(0, loc.start) + mine + existing.slice(loc.end);
    return { text: next, action: next === existing ? 'unchanged' : 'replace' };
  }
  if (!existing.trim()) return { text: `${mine}${eol}`, action: 'append' };
  const sep = existing.endsWith('\n') ? eol : eol + eol;
  return { text: `${existing}${sep}${mine}${eol}`, action: 'append' };
}

/** Remove the block and the blank line that separated it. Returns the new text (unchanged when absent). */
export function removeBlock(text, style = 'html') {
  const loc = findBlock(text, style);
  if (!loc || loc.malformed) return text;
  let before = text.slice(0, loc.start);
  const after = text.slice(loc.end).replace(/^\r?\n/, '');
  before = before.replace(/(\r?\n){2,}$/, (m) => (m.includes('\r') ? '\r\n' : '\n'));
  if (!before.trim()) before = '';
  return before + after;
}
