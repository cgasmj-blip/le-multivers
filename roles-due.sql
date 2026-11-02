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
