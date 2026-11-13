// Shared full-screen photo viewer: next/previous, caption, close (button, Escape, browser/OS back),
// pinch-to-zoom, double-tap zoom, pan, wheel zoom on desktop. Focus returns to the opener.
//
//   html`<${PhotoViewer} photos=${[{ id, url, alt, caption, date }]} index=${0} onClose=${close} />`
//
// Opened from inside a Sheet (e.g. a record's detail sheet), pass `overSheet` so it stacks above it.
import { html, useEffect, useRef, useState } from '../../../vendor/preact.js';
import { t, formatDate } from '../i18n.js';
import { IconButton } from './button.js';
import { useCloseOnBack } from './back-close.js';

/**
 * @typedef {object} ViewerPhoto
 * @property {string} id
 * @property {string} url
 * @property {string} [caption]
 * @property {string} [date]       'YYYY-MM-DD'
 * @property {string} [alt]
 */

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const SWIPE_PX = 50;

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Keep the image covering its box: translation limited to the overflow on each side.
 * @param {{ scale: number, x: number, y: number }} z @param {DOMRect | null} box
 */
function bound(z, box) {
  if (!box || z.scale <= 1) return { scale: Math.max(z.scale, 1), x: 0, y: 0 };
  const maxX = ((z.scale - 1) * box.width) / 2;
  const maxY = ((z.scale - 1) * box.height) / 2;
  return { scale: z.scale, x: clamp(z.x, -maxX, maxX), y: clamp(z.y, -maxY, maxY) };
}

/**
 * @param {{ photos: ViewerPhoto[], index?: number, onIndex?: (i: number) => void, onClose: () => void,
 *   actions?: (photo: ViewerPhoto) => any, label?: string, opener?: HTMLElement | null, overSheet?: boolean }} props
 *   opener: element that gets focus back on close (iOS does not focus tapped buttons)
 *   overSheet: stack above open sheets (the viewer was opened from one)
 */
export function PhotoViewer({ photos, index = 0, onIndex, onClose, actions, label, opener: openerProp, overSheet = false }) {
  const root = useRef(/** @type {HTMLDivElement | null} */ (null));
  const stage = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [zoom, setZoomState] = useState({ scale: 1, x: 0, y: 0 });
  // The ref is updated synchronously so a burst of pointer events sees the latest zoom.
  const zoomRef = useRef(zoom);
  const setZoom = (/** @type {{ scale: number, x: number, y: number }} */ z) => {
    zoomRef.current = z;
    setZoomState(z);
  };
  const count = photos.length;
  const i = clamp(index, 0, Math.max(0, count - 1));
  const photo = photos[i];

  const go = (/** @type {number} */ delta) => {
    if (count < 2) return;
    setZoom({ scale: 1, x: 0, y: 0 });
    onIndex?.((i + delta + count) % count);
  };

  // Browser/OS back closes the viewer (never leaves the app; see back-close.js).
  useCloseOnBack(onClose);

  // Focus, scroll lock, focus returns to the opener.
  useEffect(() => {
    const opener = openerProp || /** @type {HTMLElement | null} */ (document.activeElement);
    document.body.classList.add('viewer-open');
    requestAnimationFrame(() => /** @type {HTMLElement | null} */ (root.current?.querySelector('.viewer-close'))?.focus({ preventScroll: true }));
    return () => {
      document.body.classList.remove('viewer-open');
      opener?.focus?.({ preventScroll: true });
    };
  }, []);

  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    // A sheet opened above the viewer handles its own keys.
    if (!overSheet && document.querySelector('.sheet-layer')) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'Tab') {
      const items = /** @type {HTMLElement[]} */ ([...(root.current?.querySelectorAll('button:not([disabled]), a[href]') || [])]);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      // Keep a sheet underneath from trapping focus too.
      e.stopPropagation();
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !root.current?.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  // Capture phase, so a sheet underneath does not also close on Escape.
  useEffect(() => {
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  });

  // ---- Gestures (pointer events: pinch, pan, double tap, swipe) ----
  /** @type {{ current: Map<number, { x: number, y: number }> }} */
  const pointers = useRef(new Map());
  const gesture = useRef(/** @type {any} */ (null));
  const lastTap = useRef({ t: 0, x: 0, y: 0 });

  const box = () => stage.current?.getBoundingClientRect() || null;

  /** Zoom to `scale` keeping the point (cx, cy) (client coords) still. */
  const zoomAt = (/** @type {number} */ scale, /** @type {number} */ cx, /** @type {number} */ cy, base = zoomRef.current) => {
    const b = box();
    if (!b) return base;
    const s = clamp(scale, MIN_SCALE, MAX_SCALE);
    const ox = cx - (b.left + b.width / 2);
    const oy = cy - (b.top + b.height / 2);
    const k = s / base.scale;
    return bound({ scale: s, x: ox - (ox - base.x) * k, y: oy - (oy - base.y) * k }, b);
  };

  /** @param {PointerEvent} e */
  const onPointerDown = (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest('button, a')) return;
    try {
      stage.current?.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic or already released pointer */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      const [a, b] = pts;
      gesture.current = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, start: zoomRef.current };
    } else if (pts.length === 1) {
      gesture.current = { kind: 'pan', x: e.clientX, y: e.clientY, start: zoomRef.current, moved: false };
    }
  };
  /** @param {PointerEvent} e */
  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const z = zoomAt((g.start.scale * dist) / (g.dist || 1), g.cx, g.cy, g.start);
      setZoom(bound({ scale: z.scale, x: z.x + (cx - g.cx), y: z.y + (cy - g.cy) }, box()));
    } else if (g.kind === 'pan') {
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) g.moved = true;
      if (g.start.scale > 1) setZoom(bound({ scale: g.start.scale, x: g.start.x + dx, y: g.start.y + dy }, box()));
    }
  };
  /** @param {PointerEvent} e */
  const onPointerUp = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'pinch') {
      // Lifting one finger of a pinch: continue as a pan from here.
      const rest = [...pointers.current.values()][0];
      gesture.current = rest ? { kind: 'pan', x: rest.x, y: rest.y, start: zoomRef.current, moved: true } : null;
      if (zoomRef.current.scale < 1.05) setZoom({ scale: 1, x: 0, y: 0 });
      return;
    }
    gesture.current = null;
    if (!g || g.kind !== 'pan') return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved) {
      const now = Date.now();
      const lt = lastTap.current;
      if (now - lt.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 30) {
        lastTap.current = { t: 0, x: 0, y: 0 };
        setZoom(zoomRef.current.scale > 1 ? { scale: 1, x: 0, y: 0 } : zoomAt(DOUBLE_TAP_SCALE, e.clientX, e.clientY));
      } else {
        lastTap.current = { t: now, x: e.clientX, y: e.clientY };
      }
      return;
    }
    if (g.start.scale <= 1 && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    else if (g.start.scale <= 1 && dy > SWIPE_PX * 2 && Math.abs(dy) > Math.abs(dx) * 1.5) onClose();
  };
  /** Mouse wheel / trackpad zoom on desktop. @param {WheelEvent} e */
  const onWheel = (e) => {
    if (!e.ctrlKey && Math.abs(e.deltaY) < 1) return;
    e.preventDefault();
    setZoom(zoomAt(zoomRef.current.scale * Math.exp(-e.deltaY / 300), e.clientX, e.clientY));
  };
  useEffect(() => {
    const el = stage.current;
    el?.addEventListener('wheel', onWheel, { passive: false });
    return () => el?.removeEventListener('wheel', onWheel);
  });

  if (!photo) return null;
  const zoomed = zoom.scale > 1.01;
  return html`<div
    class=${`viewer${overSheet ? ' viewer-over-sheet' : ''}`}
    role="dialog"
    aria-modal="true"
    aria-label=${label || t('common.viewer.title')}
    ref=${root}
    data-testid="photo-viewer"
  >
    <div class="viewer-top">
      <${IconButton} icon="close" class="viewer-close" label=${t('common.viewer.close')} onClick=${onClose} data-testid="viewer-close" />
      ${count > 1 ? html`<span class="viewer-count" aria-live="polite">${t('common.viewer.count', { n: i + 1, total: count })}</span>` : html`<span></span>`}
      <span class="viewer-top-end">
        ${zoomed ? html`<${IconButton} icon="minus" label=${t('common.viewer.resetZoom')} onClick=${() => setZoom({ scale: 1, x: 0, y: 0 })} data-testid="viewer-reset" />` : null}
      </span>
    </div>
    <div
      class=${`viewer-stage${zoomed ? ' is-zoomed' : ''}`}
      ref=${stage}
      onPointerDown=${onPointerDown}
      onPointerMove=${onPointerMove}
      onPointerUp=${onPointerUp}
      onPointerCancel=${onPointerUp}
      data-testid="viewer-stage"
      data-scale=${zoom.scale.toFixed(2)}
    >
      <img
        key=${photo.id}
        src=${photo.url}
        alt=${photo.alt || photo.caption || ''}
        draggable="false"
        style=${{ transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})` }}
      />
    </div>
    ${count > 1
      ? html`<${IconButton} icon="chevron-left" class="viewer-nav viewer-prev" label=${t('common.viewer.previous')} onClick=${() => go(-1)} />
          <${IconButton} icon="chevron-right" class="viewer-nav viewer-next" label=${t('common.viewer.next')} onClick=${() => go(1)} />`
      : null}
    <div class="viewer-bottom">
      ${photo.caption ? html`<p class="viewer-caption pre-line">${photo.caption}</p>` : null}
      ${photo.date ? html`<p class="viewer-date">${formatDate(photo.date, 'long')}</p>` : null}
      <p class="viewer-hint">${t('common.viewer.hint')}</p>
      ${actions ? html`<div class="viewer-actions">${actions(photo)}</div>` : null}
    </div>
  </div>`;
}
