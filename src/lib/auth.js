// Authentication and editor status.
//
//   const auth = useAuth();          // { status, user, editor }
//   const isEditor = useIsEditor();  // boolean
//   html`<${EditorOnly}><${Button}>...</${Button}></${EditorOnly}>`
//
// An editor is a signed-in user who can read their own row in `editors`. Hiding controls is
// cosmetic: RLS enforces write access.
import { createStore, useStore } from './store.js';
import { getSupabase, isOffline, AUTH_STORAGE_KEY, setTokenRenewer } from './supabase.js';
import { readJSON, writeJSON, removeKey } from './storage.js';
import { t } from './i18n.js';
import { toast } from './toast.js';
import { classifyAuthError, needsRefresh, parseStoredSession, withTimeout } from './auth-logic.js';

/**
 * @typedef {object} AuthState
 * @property {'loading' | 'signedOut' | 'signedIn'} status
 * @property {{ id: string, email?: string } | null} user
 * @property {{ displayName: string } | null} editor  null when signed out or not an editor
 * @property {'unknown' | 'yes' | 'no'} editorCheck
 */

/** @type {import('./store.js').Store<AuthState>} */
export const authStore = createStore(
  /** @type {AuthState} */ ({ status: 'loading', user: null, editor: null, editorCheck: 'unknown' }),
);

/** Run a callback when editor status changes (used by the data layer). */
export function onEditorChange(fn) {
  let prevEditor = !!authStore.get().editor;
  return authStore.subscribe((s) => {
    const now = !!s.editor;
    if (now !== prevEditor) {
      prevEditor = now;
      fn(now);
    }
  });
}

let started = false;
/** @type {(v?: unknown) => void} */
let markReady = () => {};
/** Resolves once the stored session has been read at boot (or after a few seconds). */
const authReady = new Promise((resolve) => {
  markReady = resolve;
});
/** True while signOut() runs: a SIGNED_OUT then is the person's choice, not an ended session. */
let signingOut = false;

/** The session supabase-js keeps on this device (null if none, or no refresh token). */
export function storedSession() {
  try {
    return parseStoredSession(typeof localStorage === 'undefined' ? null : localStorage.getItem(AUTH_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Restore the session and follow auth changes. Call once at boot. */
export function initAuth() {
  if (started) return;
  started = true;
  const sb = getSupabase();
  setTokenRenewer(async () => (await refreshAccessToken()).token);
  sb.auth.onAuthStateChange((/** @type {string} */ event, /** @type {any} */ session) => {
    // Never await Supabase calls inside this callback (it holds an auth lock).
    setTimeout(() => applyEvent(event, session), 0);
  });
  // Show the stored session right away (editor controls on launch, no wait for a token refresh).
  // An expired token whose refresh fails for lack of network (typical when iOS resumes the app)
  // must not look like a sign-out either: keep the stored session and refresh when the network is
  // back. Only a refresh the auth server rejects ends it (SIGNED_OUT, see applyEvent).
  const stored = storedSession();
  if (stored?.user?.id) applySession(stored);
  withTimeout(sb.auth.getSession(), 8000)
    .then((/** @type {any} */ { data }) => {
      const session = data?.session ?? storedSession();
      if (session) applySession(session);
      else endSession();
    })
    .catch(() => {
      const session = storedSession();
      if (session) applySession(session);
      else endSession();
    })
    .finally(() => markReady());
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      if (needsRefresh(storedSession(), Date.now())) refreshAccessToken();
    });
  }
}

/** @param {string} event @param {any} session */
function applyEvent(event, session) {
  if (session) return applySession(session);
  // supabase-js removes the stored session before it reports SIGNED_OUT, so a session still in
  // storage means it only failed to refresh (no network): stay signed in.
  const stored = storedSession();
  if (stored && event !== 'SIGNED_OUT') return applySession(stored);
  endSession();
}

/** No session any more. If the person was signed in and did not sign out, tell them it ended. */
function endSession() {
  const wasSignedIn = authStore.get().status === 'signedIn';
  applySession(null);
  if (wasSignedIn && !signingOut) {
    toast(t('auth.sessionEnded'), { tone: 'error', duration: 10000, action: { label: t('auth.signIn'), onClick: openSignIn } });
  }
}

/** @type {Promise<{ token: string | null, error: import('./auth-logic.js').TokenError | null }> | null} */
let refreshing = null;

/**
 * Refresh the session now (one refresh at a time; concurrent callers share it).
 * @param {number} [timeoutMs] give up waiting after this (the refresh itself goes on)
 * @returns {Promise<{ token: string | null, error: import('./auth-logic.js').TokenError | null }>}
 */
export function refreshAccessToken(timeoutMs = 10000) {
  if (!storedSession()) return Promise.resolve({ token: null, error: 'signedOut' });
  if (isOffline()) return Promise.resolve({ token: null, error: 'network' });
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const { data, error } = await getSupabase().auth.refreshSession();
        if (data?.session?.access_token) return { token: data.session.access_token, error: null };
        return { token: null, error: classifyAuthError(error) };
      } catch (e) {
        return { token: null, error: classifyAuthError(e) };
      }
    })();
    const mine = refreshing;
    mine.finally(() => {
      if (refreshing === mine) refreshing = null;
    });
  }
  return withTimeout(refreshing, timeoutMs).catch(() => ({ token: null, error: /** @type {const} */ ('network') }));
}

/**
 * A user access token that is valid for at least another minute, for calls that need the editor's
 * session (the chat function, writes, uploads). Waits for the session to be restored at boot,
 * refreshes it when it is expired or about to expire, and never waits more than ~10 s.
 * `error` says why there is no token: 'network' (keep the session, say "no connection"),
 * 'expired' (the session really ended) or 'signedOut'.
 * @returns {Promise<{ token: string | null, error: import('./auth-logic.js').TokenError | null }>}
 */
export async function getAccessToken() {
  await withTimeout(authReady, 10000).catch(() => {});
  const stored = storedSession();
  if (!stored) return { token: null, error: 'signedOut' };
  if (!needsRefresh(stored, Date.now())) return { token: stored.access_token, error: null };
  return refreshAccessToken();
}

/** @type {string | null} */
let checkedUserId = null;

/** @param {any} session */
function applySession(session) {
  const user = session?.user ? { id: session.user.id, email: session.user.email } : null;
  if (!user) {
    checkedUserId = null;
    authStore.set({ status: 'signedOut', user: null, editor: null, editorCheck: 'unknown' });
    return;
  }
  const prev = authStore.get();
  if (prev.user?.id === user.id && prev.status === 'signedIn' && checkedUserId === user.id) return;
  // Optimistically reuse the cached editor name so controls show immediately on launch.
  const cached = readJSON(`editor.${user.id}`, null);
  authStore.set({
    status: 'signedIn',
    user,
    editor: cached ? { displayName: cached } : null,
    editorCheck: cached ? 'yes' : 'unknown',
  });
  checkedUserId = user.id;
  checkEditor(user.id);
}

/** @param {string} userId */
async function checkEditor(userId) {
  // Without a valid token the query would run anonymously and find no row: keep the cached state.
  const tok = await getAccessToken();
  if (tok.error) return;
  const { data, error } = await getSupabase().from('editors').select('display_name').eq('user_id', userId).maybeSingle();
  if (authStore.get().user?.id !== userId) return;
  if (error) return; // keep the cached state; a network blip should not hide controls
  if (data?.display_name) {
    writeJSON(`editor.${userId}`, data.display_name);
    authStore.set((s) => ({ ...s, editor: { displayName: data.display_name }, editorCheck: 'yes' }));
  } else {
    removeKey(`editor.${userId}`);
    authStore.set((s) => ({ ...s, editor: null, editorCheck: 'no' }));
  }
}

/**
 * Map a Supabase auth error to a translated message.
 * @param {any} error
 * @returns {string}
 */
export function authErrorMessage(error) {
  if (!error) return '';
  const code = error.code || '';
  const msg = String(error.message || '');
  if (error.name === 'AuthRetryableFetchError' || /fetch|network/i.test(msg) || error.status === 0) return t('errors.network');
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return t('auth.errors.invalidCredentials');
  if (code === 'email_not_confirmed') return t('auth.errors.emailNotConfirmed');
  if (code === 'weak_password' || /password should be/i.test(msg)) return t('auth.errors.weakPassword');
  if (code === 'same_password') return t('auth.errors.samePassword');
  if (code === 'over_request_rate_limit' || error.status === 429) return t('auth.errors.tooManyAttempts');
  return t('auth.errors.generic');
}

/**
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ error: string | null }>} translated error message or null
 */
export async function signIn(email, password) {
  try {
    const { data, error } = await getSupabase().auth.signInWithPassword({ email: email.trim(), password });
    if (error) return { error: authErrorMessage(error) };
    applySession(data.session);
    return { error: null };
  } catch (e) {
    return { error: authErrorMessage(e) };
  }
}

/** @type {Set<() => void>} */
const signOutHooks = new Set();
/** Run `fn` when the person signs out on purpose (not when a session ends): e.g. forget drafts. */
export function onSignOut(/** @type {() => void} */ fn) {
  signOutHooks.add(fn);
  return () => signOutHooks.delete(fn);
}

export async function signOut() {
  const id = authStore.get().user?.id;
  if (id) removeKey(`editor.${id}`);
  signingOut = true;
  for (const fn of signOutHooks) fn();
  try {
    await getSupabase().auth.signOut({ scope: 'local' });
  } finally {
    applySession(null);
    setTimeout(() => {
      signingOut = false;
    }, 0);
  }
}

/**
 * @param {string} newPassword
 * @returns {Promise<{ error: string | null }>}
 */
export async function changePassword(newPassword) {
  try {
    const { error } = await getSupabase().auth.updateUser({ password: newPassword });
    return { error: error ? authErrorMessage(error) : null };
  } catch (e) {
    return { error: authErrorMessage(e) };
  }
}

/** @returns {AuthState} */
export function useAuth() {
  return useStore(authStore);
}

/** @returns {boolean} */
export function useIsEditor() {
  return useStore(authStore, (s) => !!s.editor);
}

/** Non-hook check for event handlers and data code. */
export function isEditor() {
  return !!authStore.get().editor;
}

/** Display name of the current editor, or ''. */
export function editorName() {
  return authStore.get().editor?.displayName || '';
}

/**
 * Renders children only for editors (or `fallback` for everyone else).
 * @param {{ children?: any, fallback?: any }} props
 */
export function EditorOnly({ children, fallback = null }) {
  return useIsEditor() ? children : fallback;
}

// UI state for the sign-in sheet so any component can open it.
export const signInSheetStore = createStore(false);
export const openSignIn = () => signInSheetStore.set(true);
export const closeSignIn = () => signInSheetStore.set(false);
