// Inline SVG icons (24×24, stroke-based, inherit currentColor). Add new ones to PATHS.
//   html`<${Icon} name="plus" />`   decorative by default (aria-hidden); pass label to announce.
import { html } from '../../../vendor/preact.js';

/** Each icon is a list of SVG elements: path strings, or [tag, attrs] tuples. */
/** @type {Record<string, Array<string | [string, Record<string, any>]>>} */
const PATHS = {
  sun: [['circle', { cx: 12, cy: 12, r: 4 }], 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  list: ['M8 6h13M8 12h13M8 18h13', ['circle', { cx: 3.5, cy: 6, r: 1 }], ['circle', { cx: 3.5, cy: 12, r: 1 }], ['circle', { cx: 3.5, cy: 18, r: 1 }]],
  journal: ['M5 4a2 2 0 0 1 2-2h11v18H7a2 2 0 0 0-2 2z', 'M5 20V4M9 7h6M9 11h6'],
  heart: ['M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z'],
  pulse: ['M3 12h4l2-5 4 10 2-5h6'],
  book: ['M2 5h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z', 'M22 5h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z'],
  paw: [
    ['ellipse', { cx: 6, cy: 10.5, rx: 1.8, ry: 2.3 }],
    ['ellipse', { cx: 9.6, cy: 6.2, rx: 1.9, ry: 2.5 }],
    ['ellipse', { cx: 14.4, cy: 6.2, rx: 1.9, ry: 2.5 }],
    ['ellipse', { cx: 18, cy: 10.5, rx: 1.8, ry: 2.3 }],
    'M12 12.2c-2.6 0-5.2 3.2-5.2 5.6 0 1.7 1.3 2.6 2.7 2.4 1-.1 1.7-.6 2.5-.6s1.5.5 2.5.6c1.4.2 2.7-.7 2.7-2.4 0-2.4-2.6-5.6-5.2-5.6z',
  ],
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  close: ['M6 6l12 12M18 6L6 18'],
  check: ['M4 12.5l5 5L20 6.5'],
  'chevron-left': ['M15 5l-7 7 7 7'],
  'chevron-right': ['M9 5l7 7-7 7'],
  'chevron-down': ['M5 9l7 7 7-7'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  trash: ['M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'],
  user: [['circle', { cx: 12, cy: 8, r: 4 }], 'M4 21a8 8 0 0 1 16 0'],
  lock: [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }], 'M8 11V7a4 4 0 0 1 8 0v4'],
  key: [['circle', { cx: 8, cy: 15, r: 4 }], 'M11 12l9-9M17 6l3 3M15 8l2 2'],
  logout: ['M15 4h4v16h-4M10 17l5-5-5-5M15 12H3'],
  globe: [['circle', { cx: 12, cy: 12, r: 9 }], 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 20a2 2 0 0 0 4 0'],
  calendar: [['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }], 'M3 10h18M8 3v4M16 3v4'],
  clock: [['circle', { cx: 12, cy: 12, r: 9 }], 'M12 7v5l3 2'],
  bowl: ['M3 11h18a9 9 0 0 1-18 0z', 'M8 7c0-1.5 1-2 1-3M12 7c0-1.5 1-2 1-3M16 7c0-1.5 1-2 1-3'],
  drop: ['M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z'],
  poop: ['M12 4c1.5 1 1 2.5 3 3 1.6.4 2 1.6 1.6 2.6 1.9.4 2.9 1.9 2.4 3.4 1.5.8 2 2.4 1.2 3.8C19.4 18.5 17 19 12 19s-7.4-.5-8.2-2.2c-.8-1.4-.3-3 1.2-3.8-.5-1.5.5-3 2.4-3.4C7 8.6 7.6 7.4 9.4 7 11 6.6 11.2 5 12 4z'],
  walk: [['circle', { cx: 13, cy: 4.5, r: 1.8 }], 'M9 21l2-6 3 3v3M7 12l3-4 4 1 2 3 3 1M11 15l-1-4'],
  ball: [['circle', { cx: 12, cy: 12, r: 9 }], 'M5.5 5.5c3.5 3 3.5 10 0 13M18.5 5.5c-3.5 3-3.5 10 0 13'],
  scale: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }], 'M8 10a4 4 0 0 1 8 0zM12 10l1.5-2'],
  syringe: ['M18 2l4 4M20 4l-9.5 9.5M15 5l4 4M14 6l-9 9v4h4l9-9M7 13l2 2M10 10l2 2'],
  pill: [['rect', { x: 2.5, y: 8.5, width: 19, height: 7, rx: 3.5, transform: 'rotate(-45 12 12)' }], 'M8.5 8.5l7 7'],
  stethoscope: ['M5 3v6a5 5 0 0 0 10 0V3', 'M10 14v2a5 5 0 0 0 10 0v-2', ['circle', { cx: 20, cy: 12, r: 2 }]],
  alert: ['M12 3l10 18H2z', 'M12 10v5M12 18v.01'],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], 'M12 11v6M12 7.5v.01'],
  camera: ['M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z', ['circle', { cx: 12, cy: 13, r: 4 }]],
  image: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['circle', { cx: 9, cy: 10, r: 2 }], 'M21 16l-5-5-9 9'],
  download: ['M12 4v12M7 11l5 5 5-5M4 20h16'],
  share: ['M12 3v12M8 7l4-4 4 4M5 12v8h14v-8'],
  refresh: ['M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4'],
  star: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'],
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'],
  question: [['circle', { cx: 12, cy: 12, r: 9 }], 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17v.01'],
  'grad-cap': ['M2 9l10-5 10 5-10 5z', 'M6 11v5c3 2 9 2 12 0v-5M22 9v6'],
  home: ['M3 11l9-7 9 7', 'M5 10v10h14V10'],
  more: [['circle', { cx: 5, cy: 12, r: 1.3 }], ['circle', { cx: 12, cy: 12, r: 1.3 }], ['circle', { cx: 19, cy: 12, r: 1.3 }]],
  bone: ['M7.5 9.5L14.5 16.5M6 4a2.5 2.5 0 0 0-2 4 2.5 2.5 0 1 0 3.5 1.5L14.5 16.5A2.5 2.5 0 1 0 16 20a2.5 2.5 0 0 0 4-2 2.5 2.5 0 1 0-3.5-1.5L9.5 7.5A2.5 2.5 0 1 0 6 4z'],
};

export const ICON_NAMES = Object.keys(PATHS);

/**
 * @param {{ name: string, size?: number, label?: string, class?: string, strokeWidth?: number }} props
 */
export function Icon({ name, size = 24, label, class: cls, strokeWidth = 2 }) {
  const parts = PATHS[name] || PATHS.question;
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true', focusable: 'false' };
  return html`<svg
    class=${cls ? `icon ${cls}` : 'icon'}
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width=${strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
    ...${a11y}
  >
    ${parts.map((p) => (typeof p === 'string' ? html`<path d=${p} />` : html`<${p[0]} ...${p[1]} />`))}
  </svg>`;
}
