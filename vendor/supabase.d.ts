// Minimal types for the vendored supabase-js bundle (vendor/supabase.js). Hand-written; the client
// is typed loosely as `any` on purpose (query builders are deeply generic).
export function createClient(supabaseUrl: string, supabaseKey: string, options?: Record<string, any>): any;
