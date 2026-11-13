// Markdown-lite to Preact vnodes. Never uses innerHTML.
// Supports: '#'..'####' headings, paragraphs, '-'/'*' bullet lists, '1.' numbered lists,
// **bold**, *italic* / _italic_, [links](https://...), backslash escapes.
// Links: http(s) and mailto open in a new tab; '#/...' app links stay in the app; anything else
// (javascript:, data:...) is rendered as plain text.
import { h } from '../../vendor/preact.js';

/**
 * @typedef {{ type: 'text', value: string }
 *   | { type: 'strong' | 'em', children: Inline[] }
 *   | { type: 'link', href: string, external: boolean, children: Inline[] }} Inline
 * @typedef {{ type: 'heading', level: number, children: Inline[] }
 *   | { type: 'paragraph', children: Inline[] }
 *   | { type: 'list', ordered: boolean, start: number, items: Inline[][] }} Block
 */

/** @param {string} url */
export function safeHref(url) {
  const u = url.trim();
  if (/^https?:\/\/[^\s]+$/i.test(u)) return { href: u, external: true };
  if (/^mailto:[^\s]+$/i.test(u)) return { href: u, external: true };
  if (/^#\/[^\s]*$/.test(u)) return { href: u, external: false };
  return null;
}

const isWordChar = (/** @type {string | undefined} */ c) => !!c && /[\p{L}\p{N}]/u.test(c);

/**
 * Parse inline Markdown.
 * @param {string} src
 * @returns {Inline[]}
 */
export function parseInline(src) {
  /** @type {Inline[]} */
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ type: 'text', value: buf });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length && /[\\*_\[\]()#\-.!`]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '*' && src[i + 1] === '*') {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: 'strong', children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === '*' || c === '_') && src[i + 1] && src[i + 1] !== ' ' && src[i + 1] !== c) {
      // '_' only opens/closes at word boundaries so snake_case stays literal.
      if (c === '*' || !isWordChar(src[i - 1])) {
        let end = i + 1;
        while ((end = src.indexOf(c, end)) !== -1) {
          if (src[end - 1] !== ' ' && (c === '*' ? src[end + 1] !== '*' : !isWordChar(src[end + 1]))) break;
          end++;
        }
        if (end > i + 1) {
          flush();
          out.push({ type: 'em', children: parseInline(src.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }
    if (c === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        flush();
        const safe = safeHref(m[2]);
        if (safe) out.push({ type: 'link', href: safe.href, external: safe.external, children: parseInline(m[1]) });
        else out.push(...parseInline(m[1]));
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/**
 * Parse block-level Markdown.
 * @param {string} src
 * @returns {Block[]}
 */
export function parseMarkdown(src) {
  /** @type {Block[]} */
  const blocks = [];
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {string[]} */
  let para = [];
  /** @type {{ ordered: boolean, start: number, items: string[] } | null} */
  let list = null;

  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', children: parseInline(para.join(' ')) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: 'list', ordered: list.ordered, start: list.start, items: list.items.map(parseInline) });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: 'heading', level: Math.max(2, heading[1].length), children: parseInline(heading[2]) });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      }
      list.items.push(bullet ? bullet[1] : /** @type {RegExpExecArray} */ (numbered)[2]);
      continue;
    }
    if (list && /^\s{2,}/.test(raw)) {
      // Indented continuation of the previous list item.
      list.items[list.items.length - 1] += ' ' + line;
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

/** @param {Inline[]} nodes @returns {any[]} */
function inlineToVNodes(nodes) {
  return nodes.map((n, i) => {
    if (n.type === 'text') return n.value;
    if (n.type === 'strong') return h('strong', { key: i }, inlineToVNodes(n.children));
    if (n.type === 'em') return h('em', { key: i }, inlineToVNodes(n.children));
    const link = /** @type {{ href: string, external: boolean }} */ (/** @type {any} */ (n));
    const props = link.external ? { key: i, href: link.href, target: '_blank', rel: 'noopener noreferrer' } : { key: i, href: link.href };
    return h('a', props, inlineToVNodes(n.children));
  });
}

/**
 * Markdown string to an array of vnodes.
 * @param {string} src
 * @returns {any[]}
 */
export function renderMarkdown(src) {
  return parseMarkdown(src).map((b, i) => {
    if (b.type === 'heading') return h(`h${Math.min(4, b.level)}`, { key: i }, inlineToVNodes(b.children));
    if (b.type === 'paragraph') return h('p', { key: i }, inlineToVNodes(b.children));
    const items = b.items.map((it, j) => h('li', { key: j }, inlineToVNodes(it)));
    return b.ordered ? h('ol', { key: i, start: b.start === 1 ? undefined : b.start }, items) : h('ul', { key: i }, items);
  });
}

/**
 * <Markdown source=${text} /> renders inside a div.md (styled in components.css).
 * @param {{ source: string, class?: string }} props
 */
export function Markdown({ source, class: cls }) {
  return h('div', { class: cls ? `md ${cls}` : 'md' }, renderMarkdown(source));
}
