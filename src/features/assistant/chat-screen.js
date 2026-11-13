// Chat screen: '#/assistant' (new conversation) and '#/assistant?t=<thread id>'.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../../vendor/preact.js';
import { t, formatDateTime } from '../../lib/i18n.js';
import { navigate } from '../../lib/router.js';
import { Button, IconButton, Markdown, Sources, Spinner, Skeleton, EmptyState, Icon } from '../../lib/ui/index.js';
import { chatThreads, petProfile, useTimezone } from '../../data/stores.js';
import { getAge, getToday } from '../../data/derived.js';
import { DEFAULT_BIRTH_DATE } from '../../config.js';
import { ask, clearError, getDraft, session, loadThreadMessages, refreshUsage, resumeInterrupted, setDraft, stopAnswer, useSession, useThreadMessages } from './session.js';
import { canDraftFaq, cleanQuestion, draftKey, MAX_QUESTION_CHARS, pendingIsSaved, starterKeys, visibleMessages } from './logic.js';
import { BudgetIndicator, EditorGate, ErrorNotice, GlyphSend, GlyphStop } from './parts.js';
import { FaqSheet } from './faq-sheet.js';

/** @param {{ query: Record<string, string> }} props */
export function ChatScreen({ query }) {
  return html`<${EditorGate}><${Chat} threadId=${query.t || null} /></${EditorGate}>`;
}

/** Distance in px from the bottom of the viewport to the end of the page. */
function distanceToEnd() {
  const el = document.scrollingElement || document.documentElement;
  return el.scrollHeight - (el.scrollTop + window.innerHeight);
}

/** Scroll to the end of the page if the reader is already near it (or when forced). */
function scrollToEnd(force = false, slack = 0) {
  const el = document.scrollingElement || document.documentElement;
  if (force || distanceToEnd() < 240 + slack) window.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
}

/** @param {{ threadId: string | null }} props */
function Chat({ threadId }) {
  const s = useSession();
  const tz = useTimezone();
  const threads = chatThreads.useRows();
  const threadsState = chatThreads.useState();
  const thread = threadId ? threads.find((r) => r.id === threadId) : null;
  const msgs = useThreadMessages(threadId || '');
  const [faqOpen, setFaqOpen] = useState(false);
  // Composer text, saved per conversation as it is typed (a reload or relaunch keeps it).
  const key = draftKey(threadId);
  const [text, setTextState] = useState(() => getDraft(key));
  const keyRef = useRef(key);
  const setText = (/** @type {string} */ v) => {
    setTextState(v);
    setDraft(keyRef.current, v);
  };
  // Space at the end of the page for the fixed composer, whatever its height (see Composer).
  const [composerSpace, setComposerSpace] = useState(0);

  useEffect(() => {
    refreshUsage();
    if (!threadsState.loadedAt) chatThreads.load();
    resumeInterrupted();
  }, []);
  useEffect(() => {
    if (threadId) loadThreadMessages(threadId);
  }, [threadId]);
  // Another conversation: show its draft. A new conversation that just got its id keeps the text.
  useEffect(() => {
    const prev = keyRef.current;
    keyRef.current = key;
    if (prev === key) return;
    const stored = getDraft(key);
    const startedHere = prev === 'new' && session.get().pending?.threadId === key;
    if (stored || !startedHere) setTextState(stored);
    else if (text) {
      setDraft(key, text);
      setDraft(prev, '');
    }
  }, [key]);

  const rows = visibleMessages(msgs?.rows || []);
  const pending = s.pending && s.pending.threadId === threadId ? s.pending : null;
  // The streaming bubble gives way to the saved answer as soon as the thread holds it. Opening the
  // new thread's URL (at 'meta') loads its messages, and that load can arrive before 'done': without
  // this the answer and the question were shown twice for a moment.
  const answered = pendingIsSaved(pending, rows);
  const error = s.error && s.error.threadId === threadId ? s.error : null;
  const busy = !!s.pending;
  const loading = !!threadId && (!msgs || msgs.status === 'loading') && !rows.length && !pending;
  const missing = !!threadId && msgs?.status === 'ready' && !rows.length && !pending && threadsState.status === 'ready' && !thread;

  // A failed question comes back to the composer (unless something else was typed meanwhile).
  useEffect(() => {
    if (error?.question && !text.trim()) setText(error.question);
  }, [error?.question, error?.code]);

  useEffect(() => {
    scrollToEnd(true);
  }, [threadId, rows.length, !!error, error?.code]);
  useEffect(() => {
    scrollToEnd(false);
  }, [pending?.text, pending?.status]);
  // The composer grew (more lines, keyboard): keep the newest item above it if the reader was there.
  // Layout effect: the space and the scroll change in the same frame, so the newest line is never
  // painted behind the composer in between.
  const prevSpace = useRef(0);
  useLayoutEffect(() => {
    const delta = composerSpace - prevSpace.current;
    prevSpace.current = composerSpace;
    if (delta > 0) scrollToEnd(false, delta);
  }, [composerSpace]);

  /** @param {string} q */
  const send = (q) => {
    // Resending the question that failed reuses its request id: never answered (and billed) twice.
    const requestId = error && error.question === q ? error.requestId : null;
    if (text.trim() === q.trim()) setText('');
    ask(threadId, q, { requestId });
  };
  const title = thread?.title || (threadId ? '' : t('assistant.actions.newThread'));

  return html`<div class="assistant chat" data-testid="assistant-chat">
    <div class="chat-toolbar">
      <h2 class="chat-title">${title}</h2>
      <${IconButton} icon="list" label=${t('assistant.actions.threads')} onClick=${() => navigate('/assistant/threads')} data-testid="assistant-threads" />
      <${IconButton} icon="plus" label=${t('assistant.actions.newThread')} onClick=${() => navigate('/assistant')} disabled=${!threadId} data-testid="assistant-new" />
    </div>

    ${loading
      ? html`<${Skeleton} lines=${4} />`
      : missing && msgs?.status === 'ready'
        ? html`<${EmptyState} icon="question" title=${t('assistant.threads.notFound')} action=${html`<${Button} icon="plus" onClick=${() => navigate('/assistant')}>${t('assistant.actions.newThread')}</${Button}>`} />`
        : !rows.length && !pending
          ? html`<${Intro} onPick=${send} disabled=${busy} />`
          : html`<ol class="chat-log" aria-live="polite" aria-relevant="additions">
              ${rows.map((m) => html`<${Message} key=${m.id} m=${m} tz=${tz} />`)}
              ${pending && !answered
                ? html`<${PendingMessages} p=${pending} tz=${tz} />`
                : null}
            </ol>`}

    ${msgs?.status === 'error' && !rows.length ? html`<p class="form-error" role="alert">${t('assistant.threads.loadFailed')}</p>` : null}

    ${threadId && !pending && canDraftFaq(msgs?.rows || [])
      ? html`<div class="chat-faq"><${Button} variant="secondary" size="sm" icon="book" onClick=${() => setFaqOpen(true)} data-testid="assistant-save-faq">${t('assistant.actions.saveFaq')}</${Button}></div>`
      : null}

    ${error
      ? html`<${ErrorNotice} code=${error.code} usage=${s.usage} onRetry=${() => send(error.question)} onDismiss=${clearError} />`
      : null}

    <div class="chat-end" aria-hidden="true" style=${{ height: `${composerSpace}px` }}></div>
    <${Composer} busy=${busy} onSend=${send} usage=${s.usage} text=${text} setText=${setText} onSpace=${setComposerSpace} />
    ${threadId ? html`<${FaqSheet} open=${faqOpen} threadId=${threadId} onClose=${() => setFaqOpen(false)} />` : null}
  </div>`;
}

/** Empty conversation: what the assistant is for, and starter questions for his age. */
function Intro({ onPick, disabled }) {
  const tz = useTimezone();
  const profile = petProfile.useRow();
  const age = getAge(profile?.birth_date || DEFAULT_BIRTH_DATE, getToday(tz).date);
  return html`<div class="chat-intro stack">
    <div class="chat-intro-head">
      <span class="chat-intro-icon"><${Icon} name="sparkle" size=${28} /></span>
      <div>
        <p class="chat-intro-title">${t('assistant.intro.title')}</p>
        <p class="muted">${t('assistant.intro.body')}</p>
      </div>
    </div>
    <div>
      <p class="chat-starters-label">${t('assistant.starters.label')}</p>
      <ul class="chat-starters">
        ${starterKeys(age.weeks).map(
          (s) => html`<li><button type="button" class="chat-starter" disabled=${disabled} onClick=${() => onPick(t(s.key, s.vars))}>
            <${Icon} name="question" size=${18} /><span>${t(s.key, s.vars)}</span>
          </button></li>`,
        )}
      </ul>
    </div>
  </div>`;
}

/** @param {{ m: any, tz: string }} props */
function Message({ m, tz }) {
  if (m.role === 'user') {
    return html`<li class="msg msg-user">
      <p class="msg-meta">${t('assistant.askedBy', { name: m.created_by_name || t('assistant.you') })} · ${formatDateTime(m.created_at, tz)}</p>
      <div class="bubble bubble-user">${m.content}</div>
    </li>`;
  }
  const text = (m.content || '').trim();
  return html`<li class="msg msg-assistant">
    <p class="msg-meta"><${Icon} name="sparkle" size=${14} /> ${t('assistant.assistantName')}</p>
    <div class="bubble bubble-assistant">
      ${text ? html`<${Markdown} source=${text} />` : html`<p class="muted">${t('assistant.stopped')}</p>`}
      ${m.sources?.length ? html`<${Sources} sources=${m.sources} />` : null}
    </div>
  </li>`;
}

/** The question being answered and the streaming answer. */
function PendingMessages({ p, tz }) {
  return html`
    <li class="msg msg-user">
      <p class="msg-meta">${t('assistant.askedBy', { name: p.askedBy || t('assistant.you') })} · ${formatDateTime(p.startedAt, tz)}</p>
      <div class="bubble bubble-user">${p.question}</div>
    </li>
    <li class="msg msg-assistant" data-testid="assistant-streaming">
      <p class="msg-meta"><${Icon} name="sparkle" size=${14} /> ${t('assistant.assistantName')}</p>
      <div class="bubble bubble-assistant" aria-busy="true">
        ${p.text
          ? html`<${Markdown} source=${p.text} />`
          : html`<p class="chat-thinking"><${Spinner} size=${18} /> ${t(`assistant.status.${p.status === 'streaming' ? 'sending' : p.status}`)}</p>`}
      </div>
    </li>`;
}

/**
 * Composer fixed above the tab bar, or above the iOS keyboard while it is open. Reports through
 * `onSpace` how much of the page end it covers beyond the shell's bottom padding, so the chat can
 * reserve that space and the newest message or error is never hidden behind it. It also sets
 * `--composer-space` on the root so toasts sit above it.
 * @param {{ busy: boolean, onSend: (q: string) => void, usage: any, text: string, setText: (v: string) => void,
 *   onSpace: (px: number) => void }} props
 */
function Composer({ busy, onSend, usage, text, setText, onSpace }) {
  const box = useRef(/** @type {HTMLFormElement | null} */ (null));
  const input = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const tooLong = text.trim().length > MAX_QUESTION_CHARS;

  // Grow with the text up to the CSS max-height, then scroll inside the box. Before paint, so the
  // ResizeObserver below reports the new size in the same frame as the text.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = parseFloat(getComputedStyle(el).maxHeight) || 160;
    el.style.height = `${Math.min(el.scrollHeight + 2, max)}px`;
  }, [text]);

  // iOS: fixed elements do not move with the keyboard; follow the visual viewport instead.
  // Measure what the composer covers whenever its size or position changes.
  useEffect(() => {
    const form = box.current;
    if (!form) return;
    const measure = () => {
      const main = form.closest('.app-main');
      const mainPad = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      const covered = form.offsetHeight + (parseFloat(getComputedStyle(form).bottom) || 0);
      const extra = Math.max(0, Math.ceil(covered - mainPad + 16));
      onSpace(extra);
      document.documentElement.style.setProperty('--composer-space', `${Math.ceil(form.offsetHeight)}px`);
    };
    const vv = window.visualViewport;
    const update = () => {
      if (vv) {
        const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        form.style.setProperty('--kb', kb > 80 ? `${Math.round(kb)}px` : '0px');
        form.classList.toggle('composer-kb', kb > 80);
      }
      measure();
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(form);
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      ro?.disconnect();
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--composer-space');
    };
  }, []);

  const submit = (/** @type {Event} */ e) => {
    e.preventDefault();
    if (busy) return;
    const q = cleanQuestion(text);
    if (!q) return;
    onSend(q);
  };

  return html`<form class="composer" ref=${box} onSubmit=${submit} data-testid="assistant-composer">
    <div class="composer-inner">
      <${BudgetIndicator} usage=${usage} />
      ${tooLong ? html`<p class="field-error" role="alert">${t('assistant.composer.tooLong', { max: MAX_QUESTION_CHARS })}</p>` : null}
      <div class="composer-row">
        <label class="sr-only" for="assistant-input">${t('assistant.composer.label')}</label>
        <textarea
          id="assistant-input"
          ref=${input}
          class="input composer-input"
          rows="1"
          enterkeyhint="send"
          autocomplete="off"
          placeholder=${t('assistant.composer.placeholder')}
          value=${text}
          onInput=${(/** @type {any} */ e) => setText(e.currentTarget.value)}
          onKeyDown=${(/** @type {KeyboardEvent} */ e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
          }}
        ></textarea>
        ${busy
          ? html`<button type="button" class="composer-btn composer-stop" aria-label=${t('assistant.composer.stop')} title=${t('assistant.composer.stop')} onClick=${stopAnswer} data-testid="assistant-stop"><${GlyphStop} /></button>`
          : html`<button type="submit" class="composer-btn" aria-label=${t('assistant.composer.send')} title=${t('assistant.composer.send')} disabled=${!text.trim() || tooLong} data-testid="assistant-send"><${GlyphSend} /></button>`}
      </div>
    </div>
  </form>`;
}
