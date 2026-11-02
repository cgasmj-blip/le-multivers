alter table public.mv_registrations add column attendance text not null default 'unmarked' check(attendance in ('unmarked','present','absent','excused'));
alter table public.mv_settings add column roster_channel_id text;
alter table public.mv_events add column roster_message_id text, add column roster_channel_id text;
create function public.mv_attendance(p_event uuid,p_user uuid,p_mark text) returns void language plpgsql security invoker set search_path='' as $$
declare e public.mv_events; begin
 if p_mark not in ('unmarked','present','absent','excused') then raise exception 'Présence invalide'; end if;
 select * into e from public.mv_events where id=p_event for update;
 if not found or e.cancelled or now()<e.starts_at then raise exception 'La présence se renseigne à partir du début de la soirée'; end if;
 update public.mv_registrations set attendance=p_mark where event_id=p_event and user_id=p_user and registered;
 if not found then raise exception 'Inscription introuvable'; end if;
end $$;
revoke execute on function public.mv_attendance(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.mv_attendance(uuid,uuid,text) to service_role;
