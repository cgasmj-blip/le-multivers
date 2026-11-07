create table if not exists public.mv_ai_usage (
  day date not null,
  kind text not null check (kind in ('text', 'image')),
  used integer not null check (used >= 0),
  primary key (day, kind)
);
alter table public.mv_ai_usage enable row level security;
revoke all on public.mv_ai_usage from public, anon, authenticated;
grant select, insert, update on public.mv_ai_usage to service_role;

create or replace function public.mv_claim_ai(p_kind text, p_interaction text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  daily_limit integer;
  consumed integer;
begin
  daily_limit := case p_kind when 'text' then 100 when 'image' then 10 else null end;
  if daily_limit is null or p_interaction is null or p_interaction !~ '^[0-9]{17,20}$' then return false; end if;
  if not public.mv_claim_notification('ai:' || p_interaction) then return false; end if;
  insert into public.mv_ai_usage(day, kind, used)
  values ((now() at time zone 'Europe/Paris')::date, p_kind, 1)
  on conflict (day, kind) do update set used = mv_ai_usage.used + 1
  where mv_ai_usage.used < daily_limit
  returning used into consumed;
  return consumed is not null;
end;
$$;
revoke all on function public.mv_claim_ai(text, text) from public, anon, authenticated;
grant execute on function public.mv_claim_ai(text, text) to service_role;
