alter table public.mv_events add column is_test boolean not null default false;
create table public.mv_cancellation_logs (
 id uuid primary key default gen_random_uuid(),event_id uuid not null references public.mv_events(id),
 actor_discord_id text not null,actor_name text not null,game text not null,starts_at timestamptz not null,
 cancelled_at timestamptz not null default now(),message_id text,error text
);
alter table public.mv_cancellation_logs enable row level security;
revoke all on public.mv_cancellation_logs from public,anon,authenticated;
grant all on public.mv_cancellation_logs to service_role;
create index mv_cancellation_logs_event on public.mv_cancellation_logs(event_id);
create function public.mv_cancel_event(p_event uuid,p_cancelled boolean,p_actor text,p_name text) returns void language plpgsql security invoker set search_path='' as $$
declare e public.mv_events;begin
 select * into e from public.mv_events where id=p_event for update;
 if not found then raise exception 'Soirée introuvable';end if;
 if e.cancelled is not distinct from p_cancelled then return;end if;
 update public.mv_events set cancelled=p_cancelled where id=p_event;
 if p_cancelled then insert into public.mv_cancellation_logs(event_id,actor_discord_id,actor_name,game,starts_at) values(e.id,p_actor,p_name,e.game,e.starts_at);end if;
end $$;
revoke execute on function public.mv_cancel_event(uuid,boolean,text,text) from public,anon,authenticated;
grant execute on function public.mv_cancel_event(uuid,boolean,text,text) to service_role;
