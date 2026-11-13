// Feature: assistant (chat with Claude). No tab: editors open it from the header button.
// The answers come from the `chat` Edge Function (supabase/functions/chat).
import { ChatScreen } from './chat-screen.js';
import { ThreadsScreen } from './threads-screen.js';

/** @type {import('../registry.js').Feature} */
export const feature = {
  id: 'assistant',
  routes: [
    { path: '/assistant', component: ChatScreen, titleKey: 'assistant.title' },
    { path: '/assistant/threads', component: ThreadsScreen, titleKey: 'assistant.threadsTitle', back: '/assistant' },
  ],
};
