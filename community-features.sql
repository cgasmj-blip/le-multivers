alter table public.mv_settings add column reminder_channel_id text,add column winner_channel_id text,add column weekly_channel_id text,add column suggestions_channel_id text,add column discord_public_key text;
alter table public.mv_profiles add column blocked_until timestamptz,add column absence_penalty_threshold integer not null default 0;
create table public.mv_notifications(key text primary key,until_at timestamptz not null default now()+interval '2 minutes',message_id text,error text);
alter table public.mv_notifications enable row level security;
revoke all on public.mv_notifications from public,anon,authenticated;
grant all on public.mv_notifications to service_role;
create function public.mv_claim_notification(p_key text) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 insert into public.mv_notifications(key) values(p_key) on conflict do nothing;if found then return true;end if;
 update public.mv_notifications set until_at=now()+interval '2 minutes' where key=p_key and message_id is null and until_at<now();return found;
end $$;
revoke execute on function public.mv_claim_notification(text) from public,anon,authenticated;
grant execute on function public.mv_claim_notification(text) to service_role;
create table public.mv_feedback(event_id uuid references public.mv_events(id),discord_id text not null,score integer not null check(score between 1 and 5),comment text not null default '' check(length(comment)<=1000),created_at timestamptz not null default now(),primary key(event_id,discord_id));
alter table public.mv_feedback enable row level security;
revoke all on public.mv_feedback from public,anon,authenticated;
grant all on public.mv_feedback to service_role;
create function public.mv_enforce_absences(p_user uuid) returns void language plpgsql security invoker set search_path='' as $$
declare n integer;p public.mv_profiles;threshold integer;begin
 select * into p from public.mv_profiles where user_id=p_user for update;
 select count(*) into n from public.mv_registrations r join public.mv_events e on e.id=r.event_id where r.user_id=p_user and r.registered and r.attendance='absent' and not e.cancelled;
 threshold:=(n/3)*3;
 if threshold>p.absence_penalty_threshold then update public.mv_profiles set blocked_until=now()+interval '7 days',absence_penalty_threshold=threshold where user_id=p_user;
 elsif threshold<p.absence_penalty_threshold then update public.mv_profiles set blocked_until=null,absence_penalty_threshold=threshold where user_id=p_user;end if;
end $$;
revoke execute on function public.mv_enforce_absences(uuid) from public,anon,authenticated;
grant execute on function public.mv_enforce_absences(uuid) to service_role;

create or replace function public.mv_register(p_event uuid,p_user uuid,p_registered boolean) returns void language plpgsql security invoker set search_path='' as $$
declare e public.mv_events; n integer; begin
 select * into e from public.mv_events where id=p_event for update;
 if not found then raise exception 'Soirée introuvable'; end if;
 if not p_registered and now()>=e.starts_at then raise exception 'La soirée a commencé : la désinscription n’est plus possible.';end if;
 if p_registered then
 perform public.mv_enforce_absences(p_user);
 if exists(select 1 from public.mv_profiles where user_id=p_user and blocked_until>now()) then raise exception 'Inscriptions bloquées pendant 7 jours après trois absences non excusées.';end if;
 if not e.published or e.cancelled or (e.ends_at is not null and e.ends_at<=now()) then raise exception 'Inscriptions fermées'; end if;
 select count(*) into n from public.mv_registrations where event_id=p_event and registered and user_id<>p_user;
 if n>=e.capacity then raise exception 'Cette soirée est complète'; end if;
 end if;
 insert into public.mv_registrations(event_id,user_id,registered) values(p_event,p_user,p_registered)
 on conflict(event_id,user_id) do update set registered=excluded.registered,updated_at=now();
end $$;



create or replace function public.mv_attendance(p_event uuid,p_user uuid,p_mark text) returns void language plpgsql security invoker set search_path='' as $$
declare e public.mv_events; begin
 if p_mark not in ('unmarked','present','absent','excused') then raise exception 'Présence invalide'; end if;
 select * into e from public.mv_events where id=p_event for update;
 if not found or e.cancelled or now()<e.starts_at then raise exception 'La présence se renseigne à partir du début de la soirée'; end if;
 update public.mv_registrations set attendance=p_mark where event_id=p_event and user_id=p_user and registered;
 if not found then raise exception 'Inscription introuvable'; end if;
 perform public.mv_enforce_absences(p_user);
end $$;
