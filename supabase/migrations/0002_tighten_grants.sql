-- Defence in depth: RLS already blocks these, but anonymous visitors should not even hold the privileges.
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
revoke all on public.pet_private, public.vet_visit_private, public.editors from anon;
revoke insert, update, delete on public.editors from authenticated;
revoke delete on public.pet_profile, public.settings, public.pet_private from authenticated;
-- Future tables must be granted explicitly.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, public;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
