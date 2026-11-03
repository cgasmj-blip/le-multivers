alter table public.mv_cancellation_logs drop constraint mv_cancellation_logs_action_check;
alter table public.mv_cancellation_logs add constraint mv_cancellation_logs_action_check check(action in ('programmation','annulation','fin','suppression','restauration'));
create or replace function public.mv_queue_event_log(p_event uuid,p_actor text,p_name text,p_action text) returns void language plpgsql security invoker set search_path='' as $$
begin
 if p_action not in ('programmation','fin','suppression','restauration') then raise exception 'Action invalide';end if;
 insert into public.mv_cancellation_logs(event_id,actor_discord_id,actor_name,game,starts_at,action)
 select id,p_actor,p_name,game,starts_at,p_action from public.mv_events where id=p_event on conflict do nothing;
end $$;
