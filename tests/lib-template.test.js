import test from 'node:test';
import assert from 'node:assert/strict';
import { render, parse } from '../src/lib/template.js';
import { BatonError } from '../src/lib/errors.js';

const S = { strict: true };

test('variables: dotted paths, arrays, numbers, no escaping', () => {
  const vars = { project: { name: 'a<b>&"c"' }, n: 0, list: ['x', 'y'], flag: false };
  assert.equal(render('{{project.name}}', vars, S), 'a<b>&"c"');
  assert.equal(render('{{ n }}', vars, S), '0');
  assert.equal(render('{{list}}', vars, S), 'x, y');
  assert.equal(render('{{flag}}', vars, S), 'false');
});

test('missing variable: empty when lenient, error when strict', () => {
  assert.equal(render('a{{nope}}b{{x.y.z}}c', {}), 'abc');
  assert.throws(() => render('{{nope}}', {}, S), BatonError);
  assert.throws(() => render('{{x.y}}', { x: {} }, S), /missing variable "x.y"/);
  assert.throws(() => render('{{o}}', { o: { a: 1 } }, S), /object/);
});

test('if / else', () => {
  const t = '{{#if a}}yes{{else}}no{{/if}}';
  const rows = [[{ a: true }, 'yes'], [{ a: 'text' }, 'yes'], [{ a: [1] }, 'yes'], [{ a: [] }, 'no'], [{ a: '' }, 'no'], [{ a: 0 }, 'no'], [{ a: null }, 'no'], [{}, 'no']];
  for (const [vars, want] of rows) assert.equal(render(t, vars, S), want, JSON.stringify(vars));
  assert.equal(render('{{#if a}}x{{/if}}', { a: false }, S), '');
  assert.equal(render('{{#if a.b}}x{{else}}y{{/if}}', { a: { b: 1 } }, S), 'x');
});

test('each: this, this.field, @index, parent scope', () => {
  assert.equal(render('{{#each xs}}[{{@index}}:{{this}}]{{/each}}', { xs: ['a', 'b'] }, S), '[0:a][1:b]');
  assert.equal(render('{{#each ags}}{{this.id}}={{this.name}};{{/each}}', { ags: [{ id: 'c', name: 'C' }, { id: 'x', name: 'X' }] }, S), 'c=C;x=X;');
  assert.equal(render('{{#each ags}}{{id}}@{{project}} {{/each}}', { project: 'P', ags: [{ id: 'c' }, { id: 'd' }] }, S), 'c@P d@P ');
  assert.equal(render('{{#each xs}}x{{/each}}', { xs: [] }, S), '');
  assert.equal(render('{{#each xs}}{{#each this.ys}}{{this}}{{/each}}|{{/each}}', { xs: [{ ys: [1, 2] }, { ys: [3] }] }, S), '12|3|');
  assert.throws(() => render('{{#each xs}}{{/each}}', {}, S), /missing list/);
  assert.equal(render('{{#each xs}}{{/each}}', {}), '');
  assert.throws(() => render('{{#each xs}}{{/each}}', { xs: 5 }), /not a list/);
});

test('comments vanish and standalone block lines leave no blank lines', () => {
  assert.equal(render('a{{! note }}b', {}), 'ab');
  const t = 'top\n{{#if a}}\n  inside\n{{else}}\n  other\n{{/if}}\nbottom\n';
  assert.equal(render(t, { a: true }), 'top\n  inside\nbottom\n');
  assert.equal(render(t, { a: false }), 'top\n  other\nbottom\n');
  const e = '{{#each xs}}\n- {{this}}\n{{/each}}\n{{! c }}\nend';
  assert.equal(render(e, { xs: [1, 2] }), '- 1\n- 2\nend');
  assert.equal(render('a\r\n{{#if x}}\r\nb\r\n{{/if}}\r\nc', { x: true }), 'a\r\nb\r\nc');
});

test('partials: object map, function, nested scope, standalone newline, strictness', () => {
  const partials = { rules: 'Rule for {{project}}.', list: '{{#each xs}}-{{this}}{{/each}}' };
  assert.equal(render('A {{> rules}} B', { project: 'P' }, { ...S, partials }), 'A Rule for P. B');
  assert.equal(render('{{#each xs}}{{> list}}{{/each}}', { xs: [['a']] }, { partials: { list: '<{{this}}>' } }), '<a>');
  assert.equal(render('x\n{{> rules}}\ny', { project: 'P' }, { partials }), 'x\nRule for P.\ny');
  assert.equal(render('{{> p}}', { v: 1 }, { partials: (n) => (n === 'p' ? `p${'{{v}}'}` : null) }), 'p1');
  assert.throws(() => render('{{> nope}}', {}, { ...S, partials }), /missing partial/);
  assert.equal(render('a{{> nope}}b', {}, { partials }), 'ab');
  assert.throws(() => render('{{> loop}}', {}, { partials: { loop: '{{> loop}}' } }), /nested deeper/);
});

test('partials load from templates/partials by default (missing is lenient)', () => {
  assert.equal(render('a{{> definitely-not-there}}b', {}), 'ab');
});

test('syntax errors', () => {
  const bad = ['{{#if a}}x', '{{/if}}', '{{else}}', '{{#each a}}{{/if}}', '{{#unless a}}x{{/unless}}', '{{{raw}}}', '{{bad path}}', '{{> bad name}}', '{{#if a}}{{else}}{{else}}{{/if}}'];
  for (const t of bad) assert.throws(() => parse(t), BatonError, t);
});

test('unicode and multiline text pass through untouched', () => {
  assert.equal(render('héllo\n  {{x}}\n✓', { x: 'ü' }, S), 'héllo\n  ü\n✓');
});
