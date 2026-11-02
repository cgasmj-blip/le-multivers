alter table public.mv_events alter column ends_at drop not null;
alter table public.mv_events add column roster_extra_message_ids jsonb not null default '[]'::jsonb;
-- Existing future limits become manual; completed events remain completed.
update public.mv_events set ends_at=null where ends_at>now();
create function public.mv_finish_event(p_event uuid) returns void language plpgsql security invoker set search_path='' as $$
declare e public.mv_events; begin
 select * into e from public.mv_events where id=p_event for update;
 if not found then raise exception 'Soirée introuvable';end if;
 if e.starts_at>=now() then raise exception 'La soirée n’a pas encore commencé. Utilise Annuler si nécessaire.';end if;
 if e.ends_at is null or e.ends_at>now() then update public.mv_events set ends_at=now() where id=p_event;end if;
end $$;
revoke execute on function public.mv_finish_event(uuid) from public,anon,authenticated;
grant execute on function public.mv_finish_event(uuid) to service_role;

create or replace function public.mv_register(p_event uuid,p_user uuid,p_registered boolean) returns void language plpgsql security invoker set search_path='' as $$
declare e public.mv_events; n integer; begin
 select * into e from public.mv_events where id=p_event for update;
 if not found then raise exception 'Soirée introuvable'; end if;
 if p_registered then
 if not e.published or e.cancelled or (e.ends_at is not null and e.ends_at<=now()) then raise exception 'Inscriptions fermées'; end if;
 select count(*) into n from public.mv_registrations where event_id=p_event and registered and user_id<>p_user;
 if n>=e.capacity then raise exception 'Cette soirée est complète'; end if;
 end if;
 insert into public.mv_registrations(event_id,user_id,registered) values(p_event,p_user,p_registered)
 on conflict(event_id,user_id) do update set registered=excluded.registered,updated_at=now();
end $$;

create or replace function public.mv_due_roles() returns jsonb language sql security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from (
 select r.*,to_jsonb(e) as mv_events,jsonb_build_object('discord_id',p.discord_id) as mv_profiles
 from public.mv_registrations r join public.mv_events e on e.id=r.event_id join public.mv_profiles p on p.user_id=r.user_id
 where (r.registered and e.published and not e.cancelled and now()>=e.starts_at and (e.ends_at is null or now()<e.ends_at)) is distinct from r.role_granted
 order by e.ends_at asc,r.updated_at asc limit 50
 ) t;
$$;
revoke execute on function public.mv_due_roles() from public,anon,authenticated;
grant execute on function public.mv_due_roles() to service_role;
