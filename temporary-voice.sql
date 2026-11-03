-- Service-only configuration and resumable Gateway state. No Discord bot token is stored here.
create table public.mv_voice_launchers (
 channel_id text primary key,category_id text not null unique,category_name text not null,
 created_at timestamptz not null default now()
);
create table public.mv_temporary_voices (
 channel_id text primary key,launcher_id text not null references public.mv_voice_launchers(channel_id),
 owner_id text not null,created_at timestamptz not null default now(),unique(launcher_id,owner_id)
);
create table public.mv_voice_presence (user_id text primary key,channel_id text);
create index mv_voice_presence_channel on public.mv_voice_presence(channel_id);
create table public.mv_gateway_session (
 id boolean primary key default true check(id),session_id text,resume_url text,seq bigint,
 lease_id uuid,lease_until timestamptz not null default '-infinity',last_event_at timestamptz,last_error text,
 connected_at timestamptz
);
insert into public.mv_gateway_session(id) values(true);
do $$ declare t text;begin
 foreach t in array array['mv_voice_launchers','mv_temporary_voices','mv_voice_presence','mv_gateway_session'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;end $$;
create function public.mv_acquire_gateway(p_lease uuid) returns setof public.mv_gateway_session
 language sql security invoker set search_path='' as $$
 update public.mv_gateway_session set lease_id=p_lease,lease_until=now()+interval '58 seconds'
 where id and lease_until<now() returning *;
$$;
create function public.mv_voice_snapshot(p_states jsonb) returns void language plpgsql security invoker set search_path='' as $$
begin
 delete from public.mv_voice_presence;
 insert into public.mv_voice_presence(user_id,channel_id)
 select x->>'user_id',x->>'channel_id' from jsonb_array_elements(p_states) x;
end $$;
revoke all on function public.mv_acquire_gateway(uuid),public.mv_voice_snapshot(jsonb) from public,anon,authenticated;
grant execute on function public.mv_acquire_gateway(uuid),public.mv_voice_snapshot(jsonb) to service_role;

-- Installed schedule (secret is resolved only by the database).
select cron.schedule('multivers-temporary-voices','* * * * *',$job$ select net.http_post(url:='https://ighxdlztzcifezqfxeyv.supabase.co/functions/v1/multivers-voice',headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='multivers_cron_secret')),body:='{"action":"run"}'::jsonb,timeout_milliseconds:=5000); $job$);
