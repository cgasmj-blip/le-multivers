begin;
do $$
declare u1 uuid:=gen_random_uuid(); u2 uuid:=gen_random_uuid(); e uuid; p uuid; o uuid; bad uuid; begin
 insert into auth.users(id,aud,role) values(u1,'authenticated','authenticated'),(u2,'authenticated','authenticated');
 insert into public.mv_profiles(user_id,discord_id,display_name) values(u1,'999999999999999991','Test 1'),(u2,'999999999999999992','Test 2');
 insert into public.mv_events(game,starts_at,ends_at,capacity,published) values('Test atomicité',now()+interval '1 hour',now()+interval '2 hours',1,true) returning id into e;
 perform public.mv_register(e,u1,true);
 begin perform public.mv_register(e,u2,true);raise exception 'FAIL: capacité non respectée';exception when others then if sqlerrm='FAIL: capacité non respectée' then raise;end if;end;
 perform public.mv_register(e,u1,false);perform public.mv_register(e,u2,true);
 if (select count(*) from public.mv_registrations where event_id=e and registered)<>1 then raise exception 'FAIL inscription';end if;
 insert into public.mv_polls(title,opens_at,closes_at,published) values('Test vote',now()-interval '1 hour',now()+interval '1 hour',true) returning id into p;
 insert into public.mv_options(poll_id,game) values(p,'Jeu A') returning id into o;
 perform public.mv_vote(p,u1,o);perform public.mv_vote(p,u1,o);
 if(select count(*) from public.mv_votes where poll_id=p)<>1 then raise exception 'FAIL: vote dupliqué';end if;
 update public.mv_polls set closes_at=now()-interval '1 minute' where id=p;
 begin perform public.mv_vote(p,u2,o);raise exception 'FAIL: vote après clôture';exception when others then if sqlerrm='FAIL: vote après clôture' then raise;end if;end;
 if has_table_privilege('anon','public.mv_votes','SELECT') then raise exception 'FAIL: votes publics';end if;
 if has_function_privilege('authenticated','public.mv_vote(uuid,uuid,uuid)','EXECUTE') then raise exception 'FAIL: contournement API';end if;
 if has_table_privilege('authenticated','public.mv_events','UPDATE') then raise exception 'FAIL: publication directe';end if;
end $$;
rollback;
