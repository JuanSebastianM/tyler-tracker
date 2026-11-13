// Let the browser/OS back gesture close a full-screen overlay (photo viewer) instead of leaving the
// screen, without ever navigating out of the app or to another route.
//
//   useCloseOnBack(onClose);   // in an overlay that is mounted while open
//
// How it stays safe:
// - Opening pushes one history entry with the same URL, tagged with a unique overlay id.
// - Back (popstate) closes the most recently opened overlay; nothing else happens.
// - Closing from the UI calls history.back() only when the current entry is still that overlay's
//   own entry, so the step back always lands on the in-app entry that was current when it opened.
//   If the route changed meanwhile (new entry), the overlay entry is simply left behind.
// - history.back() is asynchronous. While one is in flight, a newly opened overlay waits for it to
//   land before pushing its own entry, so quick close-then-reopen sequences cannot pile up or
//   swallow entries.
import { useEffect, useRef } from '../../../vendor/preact.js';

/** @typedef {{ id: string, close: () => void, pushed: boolean, done: boolean }} Overlay */

/** @type {Overlay[]} */
const stack = [];
/** Our own history.back() calls whose popstate has not arrived yet. */
let ownBacks = 0;
/** @type {Array<() => void>} */
let waiting = [];
let seq = 0;
let listening = false;

function flushWaiting() {
  const list = waiting;
  waiting = [];
  list.forEach((fn) => fn());
}

function onPopState() {
  if (ownBacks > 0) {
    ownBacks--;
    if (!ownBacks) flushWaiting();
    return;
  }
  // A real back gesture: close the top overlay whose entry we just left.
  const top = [...stack].reverse().find((o) => o.pushed && !o.done);
  if (!top) return;
  top.done = true;
  top.close();
}

/** @param {Overlay} o */
function push(o) {
  if (o.done) return;
  try {
    history.pushState({ ...(history.state || {}), ttOverlay: o.id }, '', location.href);
    o.pushed = true;
  } catch {
    /* history unavailable: the overlay still works, only back does not close it */
  }
}

/** @param {Overlay} o */
function open(o) {
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('popstate', onPopState);
    listening = true;
  }
  stack.push(o);
  if (ownBacks > 0) waiting.push(() => push(o));
  else push(o);
}

/** Unmount: drop the overlay; step back over its entry only if it is still the current one. @param {Overlay} o */
function release(o) {
  const i = stack.indexOf(o);
  if (i >= 0) stack.splice(i, 1);
  const closedByBack = o.done;
  o.done = true;
  if (closedByBack || !o.pushed) return;
  if (history.state?.ttOverlay !== o.id) return;
  ownBacks++;
  history.back();
  // If the popstate never arrives (back was a no-op), do not block later overlays forever.
  setTimeout(() => {
    if (ownBacks > 0) {
      ownBacks = 0;
      flushWaiting();
    }
  }, 1000);
}

/**
 * Close this overlay on browser/OS back while it is mounted.
 * @param {() => void} onClose
 */
export function useCloseOnBack(onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    /** @type {Overlay} */
    const o = { id: `o${++seq}-${Date.now()}`, close: () => closeRef.current(), pushed: false, done: false };
    open(o);
    return () => release(o);
  }, []);
}
