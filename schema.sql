-- Application schema. Writes are restricted to the Edge Function (service_role).
create table public.mv_settings (
 id boolean primary key default true check(id), guild_id text not null, manager_role_id text not null, discord_invite text not null
);
insert into public.mv_settings values(true,'1187492291892486195','1564000010247475270','https://discord.gg/TCqSHWyzXM');
create table public.mv_profiles (
 user_id uuid primary key references auth.users(id) on delete cascade,
 discord_id text unique not null check(discord_id ~ '^[0-9]{17,20}$'), display_name text not null
);
create table public.mv_events (
 id uuid primary key default gen_random_uuid(), game text not null check(length(game) between 1 and 100),
 description text not null default '' check(length(description)<=2000), image_url text not null default '',
 starts_at timestamptz not null, ends_at timestamptz not null, capacity integer not null check(capacity between 1 and 100),
 published boolean not null default false, cancelled boolean not null default false, sort_order integer not null default 0,
 role_id text unique, channel_id text, created_at timestamptz not null default now(), check(ends_at>starts_at)
);
create table public.mv_registrations (
 event_id uuid references public.mv_events(id) on delete restrict, user_id uuid references public.mv_profiles(user_id) on delete restrict,
 registered boolean not null default true, role_granted boolean not null default false, sync_error text,
 updated_at timestamptz not null default now(), primary key(event_id,user_id)
);
create index mv_registrations_user on public.mv_registrations(user_id);
create table public.mv_polls (
 id uuid primary key default gen_random_uuid(), title text not null check(length(title) between 1 and 100),
 opens_at timestamptz not null, closes_at timestamptz not null, published boolean not null default false,
 created_at timestamptz not null default now(), check(closes_at>opens_at)
);
create table public.mv_options (
 id uuid primary key default gen_random_uuid(), poll_id uuid not null references public.mv_polls(id) on delete cascade,
 game text not null check(length(game) between 1 and 100), image_url text not null default '', sort_order integer not null default 0,
 unique(poll_id,id)
);
create index mv_options_poll on public.mv_options(poll_id);
create table public.mv_votes (
 poll_id uuid not null references public.mv_polls(id) on delete cascade, user_id uuid not null references public.mv_profiles(user_id) on delete cascade,
 option_id uuid not null, updated_at timestamptz not null default now(), primary key(poll_id,user_id),
 foreign key(poll_id,option_id) references public.mv_options(poll_id,id) on delete restrict
);
create index mv_votes_option on public.mv_votes(option_id);
create index mv_votes_poll_option on public.mv_votes(poll_id,option_id);
create index mv_votes_user on public.mv_votes(user_id);
-- No client can write directly or enumerate participants/voters.
do $$ declare t text; begin
 foreach t in array array['mv_settings','mv_profiles','mv_events','mv_registrations','mv_polls','mv_options','mv_votes'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon, authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
grant select on public.mv_events,public.mv_polls,public.mv_options to anon,authenticated;
create policy published_events on public.mv_events for select to anon,authenticated using(published and not cancelled);
create policy published_polls on public.mv_polls for select to anon,authenticated using(published);
create policy published_options on public.mv_options for select to anon,authenticated using(exists(select 1 from public.mv_polls p where p.id=poll_id and p.published));
-- Service-only RPCs serialize concurrent registrations and votes.
create function public.mv_register(p_event uuid,p_user uuid,p_registered boolean) returns void language plpgsql security invoker set search_path='' as $$
declare e public.mv_events; n integer; begin
 select * into e from public.mv_events where id=p_event for update;
 if not found then raise exception 'Soirée introuvable'; end if;
 if p_registered then
 if not e.published or e.cancelled or e.ends_at<=now() then raise exception 'Inscriptions fermées'; end if;
 select count(*) into n from public.mv_registrations where event_id=p_event and registered and user_id<>p_user;
 if n>=e.capacity then raise exception 'Cette soirée est complète'; end if;
 end if;
 insert into public.mv_registrations(event_id,user_id,registered) values(p_event,p_user,p_registered)
 on conflict(event_id,user_id) do update set registered=excluded.registered,updated_at=now();
end $$;
create function public.mv_vote(p_poll uuid,p_user uuid,p_option uuid) returns void language plpgsql security invoker set search_path='' as $$
declare p public.mv_polls; begin
 select * into p from public.mv_polls where id=p_poll for update;
 if not found or not p.published or now()<p.opens_at or now()>=p.closes_at then raise exception 'Vote fermé'; end if;
 if not exists(select 1 from public.mv_options where id=p_option and poll_id=p_poll) then raise exception 'Choix invalide'; end if;
 insert into public.mv_votes(poll_id,user_id,option_id) values(p_poll,p_user,p_option)
 on conflict(poll_id,user_id) do update set option_id=excluded.option_id,updated_at=now();
end $$;
revoke execute on function public.mv_register(uuid,uuid,boolean),public.mv_vote(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.mv_register(uuid,uuid,boolean),public.mv_vote(uuid,uuid,uuid) to service_role;
create function public.mv_save_poll(p_id uuid,p_title text,p_opens timestamptz,p_closes timestamptz,p_published boolean,p_options jsonb) returns uuid language plpgsql security invoker set search_path='' as $$
declare v_id uuid; begin
 if p_id is not null then
 perform 1 from public.mv_polls where id=p_id for update;
 if not found then raise exception 'Vote introuvable'; end if;
 if exists(select 1 from public.mv_votes where poll_id=p_id) then raise exception 'Ce vote a déjà des réponses. Crée un nouveau vote pour changer les jeux.'; end if;
 update public.mv_polls set title=p_title,opens_at=p_opens,closes_at=p_closes,published=p_published where id=p_id;
 delete from public.mv_options where poll_id=p_id;v_id:=p_id;
 else
 insert into public.mv_polls(title,opens_at,closes_at,published) values(p_title,p_opens,p_closes,p_published) returning id into v_id;
 end if;
 insert into public.mv_options(poll_id,game,image_url,sort_order) select v_id,x.game,x.image_url,x.sort_order from jsonb_to_recordset(p_options) as x(game text,image_url text,sort_order integer);
 return v_id;
end $$;
revoke execute on function public.mv_save_poll(uuid,text,timestamptz,timestamptz,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.mv_save_poll(uuid,text,timestamptz,timestamptz,boolean,jsonb) to service_role;
create schema if not exists multivers_private;
revoke all on schema multivers_private from public,anon,authenticated;
create table multivers_private.sync_lease(id boolean primary key default true,until_at timestamptz not null default now());
insert into multivers_private.sync_lease values(true,now());
create function public.mv_acquire_sync() returns boolean language plpgsql security definer set search_path='' as $$
begin
 update multivers_private.sync_lease set until_at=now()+interval '90 seconds' where id and until_at<now();return found;
end $$;
create function public.mv_release_sync() returns void language sql security definer set search_path='' as $$update multivers_private.sync_lease set until_at=now() where id;$$;
revoke execute on function public.mv_acquire_sync(),public.mv_release_sync() from public,anon,authenticated;
grant execute on function public.mv_acquire_sync(),public.mv_release_sync() to service_role;
-- Cron authentication, generated within Postgres and never committed as a secret.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
select vault.create_secret(gen_random_uuid()::text||gen_random_uuid()::text,'multivers_cron_secret');
create function public.mv_verify_cron(p_secret text) returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from vault.decrypted_secrets where name='multivers_cron_secret' and decrypted_secret=p_secret);
$$;
revoke execute on function public.mv_verify_cron(text) from public,anon,authenticated;
grant execute on function public.mv_verify_cron(text) to service_role;
select cron.schedule('multivers-sync-roles','* * * * *',$job$
 select net.http_post(
 url:='https://ighxdlztzcifezqfxeyv.supabase.co/functions/v1/multivers-api',
 headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='multivers_cron_secret' limit 1)),
 body:='{"action":"sync"}'::jsonb, timeout_milliseconds:=60000);
$job$);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('multivers-images','multivers-images',true,3145728,array['image/png','image/jpeg','image/webp']);
