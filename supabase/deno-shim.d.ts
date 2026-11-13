// The few Deno globals the `chat` Edge Function uses, so `npm run typecheck` can check it with tsc.
// Not deployed (only supabase/functions/ is bundled).
declare namespace Deno {
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
  const env: { get(name: string): string | undefined };
}
