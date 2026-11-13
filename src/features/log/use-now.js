import { useEffect, useState } from '../../../vendor/preact.js';

/** Hook: the current instant as an ISO string, refreshed every `everyMs` and on tab focus. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const tick = () => setNow(new Date().toISOString());
    const id = setInterval(tick, everyMs);
    const onVis = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [everyMs]);
  return now;
}

/** Current instant (for event handlers). */
export const nowIso = () => new Date().toISOString();
