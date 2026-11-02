create or replace function public.mv_register(p_event uuid,p_user uuid,p_registered boolean) returns void language plpgsql security invoker set search_path='' as $$
declare e public.mv_events; n integer; begin
 select * into e from public.mv_events where id=p_event for update;
 if not found then raise exception 'Soirée introuvable'; end if;
 if not p_registered and now()>=e.starts_at then raise exception 'La soirée a commencé : la désinscription n’est plus possible.';end if;
 if p_registered then
 if not e.published or e.cancelled or (e.ends_at is not null and e.ends_at<=now()) then raise exception 'Inscriptions fermées'; end if;
 select count(*) into n from public.mv_registrations where event_id=p_event and registered and user_id<>p_user;
 if n>=e.capacity then raise exception 'Cette soirée est complète'; end if;
 end if;
 insert into public.mv_registrations(event_id,user_id,registered) values(p_event,p_user,p_registered)
 on conflict(event_id,user_id) do update set registered=excluded.registered,updated_at=now();
end $$;


create function multivers_private.notify_public_refresh() returns trigger language plpgsql security invoker set search_path='' as $$
begin perform realtime.send('{}'::jsonb,'refresh','multivers:public',false);return null;end $$;
revoke all on function multivers_private.notify_public_refresh() from public,anon,authenticated;
do $$ declare t text;begin
 foreach t in array array['mv_events','mv_polls','mv_options','mv_registrations','mv_votes'] loop
 execute format('create trigger mv_public_refresh after insert or update or delete on public.%I for each statement execute function multivers_private.notify_public_refresh()',t);
 end loop;
end $$;
