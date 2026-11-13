import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, renderMarkdown, safeHref } from '../../src/lib/markdown.js';

test('headings, paragraphs and lists', () => {
  const blocks = parseMarkdown('## Título\nUna línea\ny otra.\n\n- uno\n- dos\n\n3. tres\n4. cuatro\n### Sub');
  assert.deepEqual(
    blocks.map((b) => b.type + (b.type === 'heading' ? b.level : b.type === 'list' ? (b.ordered ? 'ol' + b.start : 'ul') + b.items.length : '')),
    ['heading2', 'paragraph', 'listul2', 'listol32', 'heading3'],
  );
  assert.deepEqual(blocks[1].children, [{ type: 'text', value: 'Una línea y otra.' }]);
});

test('single # becomes h2 (page h1 belongs to the shell)', () => {
  assert.equal(parseMarkdown('# Big')[0].level, 2);
});

test('bold, italic, nested and escapes', () => {
  assert.deepEqual(parseInline('a **b** *c* _d_ e'), [
    { type: 'text', value: 'a ' },
    { type: 'strong', children: [{ type: 'text', value: 'b' }] },
    { type: 'text', value: ' ' },
    { type: 'em', children: [{ type: 'text', value: 'c' }] },
    { type: 'text', value: ' ' },
    { type: 'em', children: [{ type: 'text', value: 'd' }] },
    { type: 'text', value: ' e' },
  ]);
  assert.deepEqual(parseInline('**a *b***')[0].type, 'strong');
  assert.deepEqual(parseInline('snake_case_word'), [{ type: 'text', value: 'snake_case_word' }]);
  assert.deepEqual(parseInline('2 * 3 = 6'), [{ type: 'text', value: '2 * 3 = 6' }]);
  assert.deepEqual(parseInline('\\*no\\*'), [{ type: 'text', value: '*no*' }]);
});

test('links: safe ones kept, unsafe ones become text', () => {
  const [link] = parseInline('[AKC](https://www.akc.org/)');
  assert.deepEqual(link, { type: 'link', href: 'https://www.akc.org/', external: true, children: [{ type: 'text', value: 'AKC' }] });
  assert.equal(parseInline('[FAQ](#/learn/faq)')[0].external, false);
  assert.ok(parseInline('[x](javascript:alert(1))').every((n) => n.type !== 'link'));
  assert.equal(safeHref('data:text/html,hi'), null);
  assert.equal(safeHref('//evil.example'), null);
});

test('renders vnodes: external links open in a new tab, html is not interpreted', () => {
  const nodes = renderMarkdown('Hola <b>x</b> [AKC](https://akc.org)\n\n1. a');
  const p = nodes[0];
  assert.equal(p.type, 'p');
  const children = [].concat(p.props.children);
  assert.equal(children[0], 'Hola <b>x</b> ');
  const a = children[1];
  assert.equal(a.type, 'a');
  assert.equal(a.props.target, '_blank');
  assert.equal(a.props.rel, 'noopener noreferrer');
  assert.equal(nodes[1].type, 'ol');
  assert.equal(nodes[1].props.start, undefined);
});

test('empty and whitespace input', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('\n\n  \n'), []);
  assert.deepEqual(renderMarkdown(undefined), []);
});

test('headingOffset shifts heading tags but keeps the look of the source level', () => {
  const src = '## Qué hacer\n\n### Detalle\n\n#### Nota';
  const tags = (nodes) => nodes.map((n) => `${n.type}.${n.props.class}`);
  assert.deepEqual(tags(renderMarkdown(src)), ['h2.md-h2', 'h3.md-h3', 'h4.md-h4']);
  assert.deepEqual(tags(renderMarkdown(src, { headingOffset: 1 })), ['h3.md-h2', 'h4.md-h3', 'h5.md-h4']);
  assert.deepEqual(tags(renderMarkdown('#### Nota', { headingOffset: 4 })), ['h6.md-h4'], 'never beyond h6');
});
