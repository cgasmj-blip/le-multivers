-- Private badge attribution. Only the authenticated Edge API uses these objects.
alter table public.mv_profiles add column if not exists is_founder boolean not null default false;
create table public.mv_heart_badges (
 user_id uuid primary key references public.mv_profiles(user_id) on delete cascade,
 granted_by text not null check (granted_by ~ '^[0-9]{17,20}$'),
 granted_at timestamptz not null default now()
);
create table public.mv_badge_audit (
 id bigint generated always as identity primary key,
 recipient_id uuid not null,
 actor_discord_id text not null,
 granted boolean not null,
 created_at timestamptz not null default now()
);
alter table public.mv_heart_badges enable row level security;
alter table public.mv_badge_audit enable row level security;
revoke all on public.mv_heart_badges,public.mv_badge_audit from public,anon,authenticated;
grant all on public.mv_heart_badges,public.mv_badge_audit to service_role;
grant usage,select on sequence public.mv_badge_audit_id_seq to service_role;
create or replace function public.mv_badge_collection() returns table (
 user_id uuid,display_name text,is_founder boolean,sessions bigint,games bigint,heart boolean,earned text[]
) language sql stable security invoker set search_path='' as $$
 with totals as (
 select r.user_id,count(distinct e.id) as sessions,
 count(distinct lower(regexp_replace(btrim(e.game),'\s+',' ','g'))) as games
 from public.mv_registrations r join public.mv_events e on e.id=r.event_id
 where r.registered and r.attendance='present' and e.published and not e.cancelled
 and not e.is_test and e.starts_at<=now() group by r.user_id
 ), members as (
 select p.user_id,p.display_name,p.is_founder,coalesce(t.sessions,0) as sessions,
 coalesce(t.games,0) as games,(h.user_id is not null) as heart
 from public.mv_profiles p left join totals t on t.user_id=p.user_id
 left join public.mv_heart_badges h on h.user_id=p.user_id
 ) select m.*,array_remove(array[
 case when m.is_founder or m.sessions>=1 then 'premier-voyage' end,
 case when m.is_founder or m.sessions>=5 then 'compagnon' end,
 case when m.is_founder or m.games>=5 then 'explorateur' end,
 case when m.is_founder or m.sessions>=20 then 'pilier' end,
 case when m.is_founder or m.heart then 'coeur' end
 ],null)::text[] from members m order by m.is_founder desc,lower(m.display_name),m.user_id;
$$;
revoke all on function public.mv_badge_collection() from public,anon,authenticated;
grant execute on function public.mv_badge_collection() to service_role;
create or replace function public.mv_set_heart(p_user uuid,p_granted boolean,p_actor text)
returns void language plpgsql security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.mv_profiles where user_id=p_user) then raise exception 'Membre introuvable';end if;
 if p_granted then
 insert into public.mv_heart_badges(user_id,granted_by) values(p_user,p_actor)
 on conflict(user_id) do nothing;
 else delete from public.mv_heart_badges where user_id=p_user;end if;
 insert into public.mv_badge_audit(recipient_id,actor_discord_id,granted) values(p_user,p_actor,p_granted);
end $$;
revoke all on function public.mv_set_heart(uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.mv_set_heart(uuid,boolean,text) to service_role;
create trigger mv_public_refresh after insert or update or delete on public.mv_heart_badges
 for each statement execute function multivers_private.notify_public_refresh();
