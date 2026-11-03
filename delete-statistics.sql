alter table public.mv_cancellation_logs alter column event_id drop not null;
alter table public.mv_cancellation_logs drop constraint mv_cancellation_logs_event_id_fkey;
alter table public.mv_cancellation_logs add constraint mv_cancellation_logs_event_id_fkey foreign key(event_id) references public.mv_events(id) on delete set null;
create function public.mv_delete_stat(p_kind text,p_id uuid,p_user uuid default null,p_discord text default null) returns void language plpgsql security invoker set search_path='' as $$
declare e public.mv_events; u uuid; users uuid[];begin
 if p_kind='event' then
 select * into e from public.mv_events where id=p_id for update;
 if not found then raise exception 'Soirée introuvable';end if;
 if e.resources_owned and ((e.channel_id is not null and not e.channel_closed) or (e.role_id is not null and not e.role_deleted)) then raise exception 'Le rôle et le vocal doivent être nettoyés avant la suppression';end if;
 select array_agg(distinct user_id) into users from public.mv_registrations where event_id=p_id;
 delete from public.mv_feedback where event_id=p_id;
 delete from public.mv_registrations where event_id=p_id;
 delete from public.mv_events where id=p_id;
 foreach u in array coalesce(users,'{}'::uuid[]) loop perform public.mv_enforce_absences(u);end loop;
 elsif p_kind='poll' then
 perform 1 from public.mv_polls where id=p_id for update;if not found then raise exception 'Vote introuvable';end if;
 delete from public.mv_votes where poll_id=p_id;delete from public.mv_options where poll_id=p_id;delete from public.mv_polls where id=p_id;
 elsif p_kind='registration' then
 perform 1 from public.mv_events where id=p_id for update;
 if exists(select 1 from public.mv_registrations where event_id=p_id and user_id=p_user and role_granted) then raise exception 'Le rôle doit être retiré avant la suppression';end if;
 delete from public.mv_registrations where event_id=p_id and user_id=p_user;perform public.mv_enforce_absences(p_user);
 elsif p_kind='vote' then delete from public.mv_votes where poll_id=p_id and user_id=p_user;
 elsif p_kind='feedback' then delete from public.mv_feedback where event_id=p_id and discord_id=p_discord;
 else raise exception 'Type de suppression invalide';end if;
end $$;
revoke execute on function public.mv_delete_stat(text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.mv_delete_stat(text,uuid,uuid,text) to service_role;
