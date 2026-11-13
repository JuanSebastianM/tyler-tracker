// Incremental server-sent events parser for the `chat` function's stream (pure, unit-tested).
// Same rules as supabase/functions/chat/lib/sse.ts: \n, \r\n or \r line endings, multi-line data,
// comment lines; an event ends at a blank line.

/**
 * @typedef {{ event: string, data: string }} SseEvent
 * @param {(e: SseEvent) => void} onEvent
 */
export function createSseParser(onEvent) {
  let buf = '';
  let event = '';
  /** @type {string[]} */
  let data = [];
  const dispatch = () => {
    if (data.length || event) onEvent({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
  };
  /** @param {string} l */
  const line = (l) => {
    if (l === '') return dispatch();
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  return {
    /** @param {string} chunk */
    push(chunk) {
      buf += chunk;
      const re = /\r\n|\r|\n/g;
      let start = 0;
      /** @type {RegExpExecArray | null} */
      let m;
      while ((m = re.exec(buf))) {
        if (m[0] === '\r' && m.index === buf.length - 1) break;
        line(buf.slice(start, m.index));
        start = m.index + m[0].length;
      }
      buf = buf.slice(start);
    },
    end() {
      if (buf) line(buf);
      buf = '';
      dispatch();
    },
  };
}
