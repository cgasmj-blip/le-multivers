create table public.mv_shared_roles (
 user_id uuid primary key references public.mv_profiles(user_id) on delete restrict,
 role_granted boolean not null default false, sync_error text
);
alter table public.mv_shared_roles enable row level security;
revoke all on public.mv_shared_roles from public,anon,authenticated;
grant all on public.mv_shared_roles to service_role;
create function public.mv_due_shared_roles() returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;begin
 insert into public.mv_shared_roles(user_id) select distinct user_id from public.mv_registrations on conflict do nothing;
 update public.mv_registrations r set role_granted=s.role_granted and r.registered and e.published and not e.cancelled and now()>=e.starts_at-interval '30 minutes' and (e.ends_at is null or e.ends_at>now()),sync_error=s.sync_error
 from public.mv_shared_roles s,public.mv_events e where s.user_id=r.user_id and e.id=r.event_id;
 select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into result from (
 select s.user_id,p.discord_id,s.role_granted,exists(select 1 from public.mv_registrations r join public.mv_events e on e.id=r.event_id where r.user_id=s.user_id and r.registered and e.published and not e.cancelled and now()>=e.starts_at-interval '30 minutes' and (e.ends_at is null or e.ends_at>now())) as desired
 from public.mv_shared_roles s join public.mv_profiles p on p.user_id=s.user_id
 ) t where t.desired is distinct from t.role_granted;
 return result;
end $$;
create function public.mv_record_shared_role(p_user uuid,p_granted boolean,p_error text default null) returns void language plpgsql security invoker set search_path='' as $$
begin
 update public.mv_shared_roles set role_granted=p_granted,sync_error=p_error where user_id=p_user;
 update public.mv_registrations r set role_granted=p_granted and r.registered and e.published and not e.cancelled and now()>=e.starts_at-interval '30 minutes' and (e.ends_at is null or e.ends_at>now()),sync_error=p_error from public.mv_events e where r.user_id=p_user and r.event_id=e.id;
end $$;
revoke execute on function public.mv_due_shared_roles(),public.mv_record_shared_role(uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.mv_due_shared_roles(),public.mv_record_shared_role(uuid,boolean,text) to service_role;
