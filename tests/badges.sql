begin;
do $$
declare u uuid; e uuid; ids uuid[]:='{}'; r record; i integer;
begin
 select user_id into u from public.mv_profiles limit 1;
 if u is null then raise exception 'A connected profile is required for this rollback test';end if;
 update public.mv_profiles set is_founder=false where user_id=u;
 update public.mv_registrations set attendance='unmarked' where user_id=u;
 delete from public.mv_heart_badges where user_id=u;
 select * into r from public.mv_badge_collection() where user_id=u;
 if cardinality(r.earned)<>0 then raise exception 'Empty collection failed';end if;
 for i in 1..20 loop
 insert into public.mv_events(game,starts_at,capacity,published,is_test)
 values('Badge fixture game '||((i-1)%5),now()-interval '1 hour',1,true,false) returning id into e;
 ids:=array_append(ids,e);
 insert into public.mv_registrations(event_id,user_id,attendance) values(e,u,'present');
 select * into r from public.mv_badge_collection() where user_id=u;
 if r.sessions<>i then raise exception 'Attendance count failed at %',i;end if;
 if i=1 and not ('premier-voyage'=any(r.earned)) then raise exception 'First badge failed';end if;
 if i=5 and not (array['compagnon','explorateur']<@r.earned) then raise exception '5 sessions / games failed';end if;
 if i=19 and 'pilier'=any(r.earned) then raise exception '20-session badge too early';end if;
 end loop;
 if not ('pilier'=any(r.earned)) then raise exception '20-session badge failed';end if;
 update public.mv_registrations set attendance='excused' where user_id=u and event_id=ids[20];
 select * into r from public.mv_badge_collection() where user_id=u;
 if r.sessions<>19 or 'pilier'=any(r.earned) then raise exception 'Attendance correction failed';end if;
 update public.mv_events set cancelled=true where id=ids[19];
 update public.mv_events set is_test=true where id=ids[18];
 update public.mv_events set starts_at=now()+interval '1 day' where id=ids[17];
 select * into r from public.mv_badge_collection() where user_id=u;
 if r.sessions<>16 then raise exception 'Cancelled, test, future exclusion failed';end if;
 perform public.mv_set_heart(u,true,'123456789012345678');
 select * into r from public.mv_badge_collection() where user_id=u;
 if not ('coeur'=any(r.earned)) then raise exception 'Manual heart failed';end if;
 perform public.mv_set_heart(u,false,'123456789012345678');
 update public.mv_profiles set is_founder=true where user_id=u;
 select * into r from public.mv_badge_collection() where user_id=u;
 if cardinality(r.earned)<>5 then raise exception 'Founder override failed';end if;
end $$;
rollback;
select 'Badge thresholds, corrections, exclusions, manual heart and founder override: OK (all fixtures rolled back)' as result;
