// Authentication and editor status.
//
//   const auth = useAuth();          // { status, user, editor }
//   const isEditor = useIsEditor();  // boolean
//   html`<${EditorOnly}><${Button}>...</${Button}></${EditorOnly}>`
//
// An editor is a signed-in user who can read their own row in `editors`. Hiding controls is
// cosmetic: RLS enforces write access.
import { createStore, useStore } from './store.js';
import { getSupabase } from './supabase.js';
import { readJSON, writeJSON, removeKey } from './storage.js';
import { t } from './i18n.js';

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

/** Restore the session and follow auth changes. Call once at boot. */
export function initAuth() {
  if (started) return;
  started = true;
  const sb = getSupabase();
  sb.auth.onAuthStateChange((/** @type {string} */ event, /** @type {any} */ session) => {
    // Never await Supabase calls inside this callback (it holds an auth lock).
    setTimeout(() => applySession(session), 0);
  });
  sb.auth
    .getSession()
    .then((/** @type {any} */ { data }) => applySession(data?.session ?? null))
    .catch(() => applySession(null));
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

export async function signOut() {
  const id = authStore.get().user?.id;
  if (id) removeKey(`editor.${id}`);
  try {
    await getSupabase().auth.signOut({ scope: 'local' });
  } finally {
    applySession(null);
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
