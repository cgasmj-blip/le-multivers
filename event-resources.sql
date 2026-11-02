alter table public.mv_events add column resources_owned boolean not null default false,
 add column resources_busy_until timestamptz, add column channel_closed boolean not null default false,
 add column resource_error text;
update public.mv_events set role_id=null,channel_id=null where role_id='1566911321612623963';
create function public.mv_claim_resources(p_event uuid) returns boolean language plpgsql security invoker set search_path='' as $$
begin update public.mv_events set resources_busy_until=now()+interval '90 seconds' where id=p_event and (resources_busy_until is null or resources_busy_until<now());return found;end $$;
revoke execute on function public.mv_claim_resources(uuid) from public,anon,authenticated;
grant execute on function public.mv_claim_resources(uuid) to service_role;
create or replace function public.mv_due_roles() returns jsonb language sql security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from (
 select r.*,to_jsonb(e) as mv_events,jsonb_build_object('discord_id',p.discord_id) as mv_profiles
 from public.mv_registrations r join public.mv_events e on e.id=r.event_id join public.mv_profiles p on p.user_id=r.user_id
 where e.resources_owned and e.role_id is not null and
 (r.registered and e.published and not e.cancelled and now()>=e.starts_at-interval '30 minutes' and (e.ends_at is null or now()<e.ends_at)) is distinct from r.role_granted
 order by e.ends_at asc nulls last,r.updated_at asc limit 50
 ) t;
$$;
