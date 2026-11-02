alter table public.mv_cancellation_logs add column action text not null default 'annulation' check(action in ('programmation','annulation','fin'));
create unique index mv_unique_event_action on public.mv_cancellation_logs(event_id,action) where action<>'annulation';
create function public.mv_queue_event_log(p_event uuid,p_actor text,p_name text,p_action text) returns void language plpgsql security invoker set search_path='' as $$
begin
 if p_action not in ('programmation','fin') then raise exception 'Action invalide';end if;
 insert into public.mv_cancellation_logs(event_id,actor_discord_id,actor_name,game,starts_at,action)
 select id,p_actor,p_name,game,starts_at,p_action from public.mv_events where id=p_event on conflict do nothing;
end $$;
revoke execute on function public.mv_queue_event_log(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.mv_queue_event_log(uuid,text,text,text) to service_role;
