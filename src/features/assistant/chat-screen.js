// Chat screen: '#/assistant' (new conversation) and '#/assistant?t=<thread id>'.
import { html, useEffect, useRef, useState } from '../../../vendor/preact.js';
import { t, formatDateTime } from '../../lib/i18n.js';
import { navigate } from '../../lib/router.js';
import { Button, IconButton, Markdown, Sources, Spinner, Skeleton, EmptyState, Icon } from '../../lib/ui/index.js';
import { chatThreads, petProfile, useTimezone } from '../../data/stores.js';
import { getAge, getToday } from '../../data/derived.js';
import { DEFAULT_BIRTH_DATE } from '../../config.js';
import { ask, clearError, loadThreadMessages, refreshUsage, stopAnswer, useSession, useThreadMessages } from './session.js';
import { canDraftFaq, cleanQuestion, MAX_QUESTION_CHARS, starterKeys, visibleMessages } from './logic.js';
import { BudgetIndicator, EditorGate, ErrorNotice, GlyphSend, GlyphStop } from './parts.js';
import { FaqSheet } from './faq-sheet.js';

/** @param {{ query: Record<string, string> }} props */
export function ChatScreen({ query }) {
  return html`<${EditorGate}><${Chat} threadId=${query.t || null} /></${EditorGate}>`;
}

/** Scroll to the end of the page if the reader is already near it (or when forced). */
function scrollToEnd(force = false) {
  const el = document.scrollingElement || document.documentElement;
  const near = el.scrollHeight - (el.scrollTop + window.innerHeight) < 240;
  if (force || near) window.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
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

  useEffect(() => {
    refreshUsage();
    if (!threadsState.loadedAt) chatThreads.load();
  }, []);
  useEffect(() => {
    if (threadId) loadThreadMessages(threadId);
  }, [threadId]);

  const rows = visibleMessages(msgs?.rows || []);
  const pending = s.pending && s.pending.threadId === threadId ? s.pending : null;
  const error = s.error && s.error.threadId === threadId ? s.error : null;
  const busy = !!s.pending;
  const loading = !!threadId && (!msgs || msgs.status === 'loading') && !rows.length && !pending;
  const missing = !!threadId && msgs?.status === 'ready' && !rows.length && !pending && threadsState.status === 'ready' && !thread;

  useEffect(() => {
    scrollToEnd(true);
  }, [threadId, rows.length, !!error]);
  useEffect(() => {
    scrollToEnd(false);
  }, [pending?.text, pending?.status]);

  const send = (/** @type {string} */ q) => ask(threadId, q);
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
              ${pending && !(pending.savedId && rows.some((m) => m.id === pending.savedId))
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

    <${Composer} busy=${busy} onSend=${send} usage=${s.usage} restore=${error?.question || ''} />
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
          : html`<p class="chat-thinking"><${Spinner} size=${18} /> ${t(p.status === 'searching' ? 'assistant.status.searching' : 'assistant.status.sending')}</p>`}
      </div>
    </li>`;
}

/**
 * Composer fixed above the tab bar, or above the iOS keyboard while it is open.
 * @param {{ busy: boolean, onSend: (q: string) => void, usage: any, restore: string }} props
 */
function Composer({ busy, onSend, usage, restore }) {
  const [text, setText] = useState('');
  const box = useRef(/** @type {HTMLFormElement | null} */ (null));
  const input = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const tooLong = text.trim().length > MAX_QUESTION_CHARS;

  // Put a failed question back in the box so it can be edited and resent.
  useEffect(() => {
    if (restore && !text) setText(restore);
  }, [restore]);

  // Grow with the text (up to ~6 lines).
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  // iOS: fixed elements do not move with the keyboard; follow the visual viewport instead.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      box.current?.style.setProperty('--kb', kb > 80 ? `${Math.round(kb)}px` : '0px');
      box.current?.classList.toggle('composer-kb', kb > 80);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  const submit = (/** @type {Event} */ e) => {
    e.preventDefault();
    if (busy) return;
    const q = cleanQuestion(text);
    if (!q) return;
    setText('');
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
