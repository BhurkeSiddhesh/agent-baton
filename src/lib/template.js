import fs from 'node:fs';
import path from 'node:path';
import { BatonError } from './errors.js';
import { templatesDir } from './paths.js';

const TAG_RE = /\{\{([\s\S]*?)\}\}/g;
const PATH_RE = /^(?:this(?:\.[\w-]+(?:\.[\w-]+)*)?|@index|[\w-]+(?:\.[\w-]+)*)$/;
const MAX_PARTIAL_DEPTH = 20;

function fail(msg) {
  return new BatonError(`template: ${msg}`, { code: 'TEMPLATE' });
}

function tokenize(src) {
  const tokens = []; // alternating text, tag, text, ..., text
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    tokens.push({ type: 'text', value: src.slice(last, m.index) });
    const body = m[1].trim();
    let tag;
    if (body.startsWith('!')) tag = { type: 'comment' };
    else if (body.startsWith('#if ')) tag = { type: 'if', path: body.slice(4).trim() };
    else if (body.startsWith('#each ')) tag = { type: 'each', path: body.slice(6).trim() };
    else if (body === '/if') tag = { type: 'endif' };
    else if (body === '/each') tag = { type: 'endeach' };
    else if (body === 'else') tag = { type: 'else' };
    else if (body.startsWith('>')) tag = { type: 'partial', name: body.slice(1).trim() };
    else if (body.startsWith('#') || body.startsWith('/') || body.startsWith('{') || body.startsWith('&')) throw fail(`unsupported tag {{${body}}}`);
    else tag = { type: 'var', path: body };
    if ((tag.type === 'var' || tag.type === 'if' || tag.type === 'each') && !PATH_RE.test(tag.path)) throw fail(`invalid path "${tag.path}"`);
    if (tag.type === 'partial' && !/^[\w.-]+$/.test(tag.name)) throw fail(`invalid partial name "${tag.name}"`);
    tokens.push(tag);
    last = m.index + m[0].length;
  }
  tokens.push({ type: 'text', value: src.slice(last) });
  return tokens;
}

// Block tags, comments and partials alone on their line vanish with the line (Mustache "standalone" rule).
function stripStandalone(tokens) {
  const standalone = [];
  for (let i = 1; i < tokens.length; i += 2) {
    const tag = tokens[i];
    if (tag.type === 'var') { standalone[i] = false; continue; }
    const before = tokens[i - 1].value;
    const after = tokens[i + 1].value;
    const isLast = i + 1 === tokens.length - 1;
    const startOk = before.includes('\n') ? /\n[ \t]*$/.test(before) : /^[ \t]*$/.test(before) && (i - 1 === 0 || standalone[i - 2] === true);
    const endOk = /^[ \t]*\r?\n/.test(after) || (isLast && /^[ \t]*$/.test(after));
    standalone[i] = startOk && endOk;
    if (standalone[i]) {
      tokens[i - 1].value = before.replace(/[ \t]*$/, '');
      tokens[i + 1].value = after.replace(/^[ \t]*\r?\n?/, '');
      tag.standalone = after.slice(0, after.length - tokens[i + 1].value.length).includes('\n');
    }
  }
}

/** Parse a template into a tree. Throws BatonError on unbalanced or unknown tags. */
export function parse(src) {
  const tokens = tokenize(String(src));
  stripStandalone(tokens);
  const root = { body: [] };
  const stack = [{ node: root, list: root.body }];
  const top = () => stack[stack.length - 1];
  for (const t of tokens) {
    if (t.type === 'text') { if (t.value) top().list.push({ type: 'text', value: t.value }); continue; }
    if (t.type === 'comment') continue;
    if (t.type === 'var' || t.type === 'partial') { top().list.push(t); continue; }
    if (t.type === 'if') {
      const node = { type: 'if', path: t.path, then: [], else: [] };
      top().list.push(node);
      stack.push({ node, list: node.then });
    } else if (t.type === 'each') {
      const node = { type: 'each', path: t.path, body: [] };
      top().list.push(node);
      stack.push({ node, list: node.body });
    } else if (t.type === 'else') {
      const f = top();
      if (f.node.type !== 'if' || f.list === f.node.else) throw fail('{{else}} outside {{#if}}');
      f.list = f.node.else;
    } else if (t.type === 'endif' || t.type === 'endeach') {
      const want = t.type === 'endif' ? 'if' : 'each';
      if (stack.length === 1 || top().node.type !== want) throw fail(`unexpected {{/${want}}}`);
      stack.pop();
    }
  }
  if (stack.length !== 1) throw fail(`unclosed {{#${top().node.type}}}`);
  return root.body;
}

function lookup(pathStr, scopes) {
  const cur = scopes[scopes.length - 1];
  if (pathStr === '@index') return cur.index === undefined ? { found: false } : { found: true, value: cur.index };
  if (pathStr === 'this') return { found: true, value: cur.item };
  const parts = pathStr.split('.');
  if (parts[0] === 'this') {
    let v = cur.item;
    for (const k of parts.slice(1)) {
      if (v == null || typeof v !== 'object' || !(k in Object(v))) return { found: false };
      v = v[k];
    }
    return { found: true, value: v };
  }
  for (let i = scopes.length - 1; i >= 0; i--) {
    const item = scopes[i].item;
    if (item && typeof item === 'object' && parts[0] in item) {
      let v = item[parts[0]];
      for (const k of parts.slice(1)) {
        if (v == null || typeof v !== 'object' || !(k in Object(v))) return { found: false };
        v = v[k];
      }
      return { found: true, value: v };
    }
  }
  return { found: false };
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
}

function show(v, strict, p) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  if (typeof v === 'object') {
    if (strict) throw fail(`"${p}" is an object and cannot be printed`);
    return JSON.stringify(v);
  }
  return String(v);
}

function loadPartial(name, opts) {
  const src = opts.partials;
  if (typeof src === 'function') return src(name);
  if (src && Object.prototype.hasOwnProperty.call(src, name)) return src[name];
  const dir = opts.partialsDir || path.join(templatesDir(), 'partials');
  try {
    return fs.readFileSync(path.join(dir, `${name}.md`), 'utf8');
  } catch {
    return null;
  }
}

function renderNodes(nodes, scopes, opts, depth) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.value;
    else if (n.type === 'var') {
      const r = lookup(n.path, scopes);
      if (!r.found || r.value === undefined) {
        if (opts.strict) throw fail(`missing variable "${n.path}"`);
      } else out += show(r.value, opts.strict, n.path);
    } else if (n.type === 'if') {
      const r = lookup(n.path, scopes);
      out += renderNodes(r.found && truthy(r.value) ? n.then : n.else, scopes, opts, depth);
    } else if (n.type === 'each') {
      const r = lookup(n.path, scopes);
      if (!r.found || r.value == null) {
        if (opts.strict) throw fail(`missing list "${n.path}"`);
        continue;
      }
      if (!Array.isArray(r.value)) throw fail(`"${n.path}" is not a list`);
      r.value.forEach((item, index) => {
        out += renderNodes(n.body, [...scopes, { item, index }], opts, depth);
      });
    } else if (n.type === 'partial') {
      if (depth >= MAX_PARTIAL_DEPTH) throw fail(`partials nested deeper than ${MAX_PARTIAL_DEPTH} (cycle?)`);
      const body = loadPartial(n.name, opts);
      if (body == null) {
        if (opts.strict) throw fail(`missing partial "${n.name}"`);
        continue;
      }
      let text = renderNodes(parse(body), scopes, opts, depth + 1);
      if (n.standalone && text && !text.endsWith('\n')) text += '\n';
      out += text;
    }
  }
  return out;
}

/**
 * Render a Mustache-lite template: {{var}}, {{#if p}}..{{else}}..{{/if}}, {{#each p}}..{{this}}/{{this.f}}/{{@index}}..{{/each}},
 * {{> partial}}, {{!comment}}. Nothing is HTML-escaped.
 * @param {string} template
 * @param {object} vars
 * @param {{strict?: boolean, partials?: Record<string,string>|((name:string)=>string|null), partialsDir?: string}} [opts]
 *   strict: missing variables throw (default: render ''). Partials default to templates/partials/<name>.md.
 */
export function render(template, vars = {}, opts = {}) {
  return renderNodes(parse(template), [{ item: vars }], { strict: false, ...opts }, 0);
}

/** Render a template file. */
export function renderFile(file, vars, opts) {
  return render(fs.readFileSync(file, 'utf8'), vars, opts);
}
