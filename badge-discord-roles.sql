create table public.mv_badge_discord (
 badge_id text primary key check(badge_id in ('premier-voyage','compagnon','explorateur','pilier','coeur')),
 role_id text unique,emoji_id text unique,emoji_name text unique
);
alter table public.mv_badge_discord enable row level security;
revoke all on public.mv_badge_discord from public,anon,authenticated;
grant all on public.mv_badge_discord to service_role;
