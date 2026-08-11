-- The Board -- core schema
-- Run this once in the Supabase SQL editor for a fresh project.
-- See ../SETUP.md for the full setup walkthrough.

-- ============================================================
-- profiles: one row per auth.users row (id is shared 1:1).
-- auth.users.id already IS each user's unique ID -- no extra
-- ID generation needed anywhere in this schema.
-- ============================================================
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text not null unique,
  display_name  text,
  avatar_url    text,
  favorite_team text check (favorite_team in (
    'ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND',
    'JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF',
    'TB','TEN','WAS'
  )),
  role          text not null default 'user' check (role in ('user','editor','admin')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy profiles_select_all on public.profiles
  for select using (true);

-- Users may update their own row, but only via the column grant below --
-- role and id are excluded from the grant so a plain UPDATE can never
-- touch them. protect_profile_fields() below is a second, redundant
-- guard against the same thing.
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

grant select on public.profiles to anon, authenticated;
grant update (username, display_name, avatar_url, favorite_team) on public.profiles to authenticated;

create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- auth.uid() is null for direct SQL-editor / superuser connections
  -- (no PostgREST JWT context) -- those are trusted, so only enforce
  -- the admin check for requests that came in as an authenticated user.
  if auth.uid() is not null
     and not exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') then
    new.role := old.role;
    new.id := old.id;
  end if;
  return new;
end;
$$;

create trigger protect_profile_fields_trigger
  before update on public.profiles
  for each row execute procedure public.protect_profile_fields();

-- ============================================================
-- permissions / role_permissions: the "policies" tying roles to
-- features. Read by both the frontend (to gate UI) and helper
-- SQL functions (to gate writes). Only admins can edit these.
-- ============================================================
create table public.permissions (
  key         text primary key,
  description text not null
);

create table public.role_permissions (
  role           text not null check (role in ('user','editor','admin')),
  permission_key text not null references public.permissions(key) on delete cascade,
  allowed        boolean not null default true,
  primary key (role, permission_key)
);

alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;

create policy permissions_select_all on public.permissions for select using (true);
create policy role_permissions_select_all on public.role_permissions for select using (true);

grant select on public.permissions to anon, authenticated;
grant select on public.role_permissions to anon, authenticated;
-- writes to both tables happen only through the admin-only RPCs further down.

-- ============================================================
-- has_permission / is_admin: helper functions used by RLS
-- policies and RPCs below.
-- ============================================================
create or replace function public.is_admin(uid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles where id = uid and role = 'admin');
$$;

create or replace function public.has_permission(uid uuid, perm text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select rp.allowed
       from public.role_permissions rp
       join public.profiles p on p.role = rp.role
      where p.id = uid and rp.permission_key = perm),
    false
  );
$$;

grant execute on function public.is_admin(uuid) to anon, authenticated;
grant execute on function public.has_permission(uuid, text) to anon, authenticated;

-- ============================================================
-- rankings: one row per (owner, player) -- each user's personal
-- ranking, "held on individual files for individual people."
-- player_key = lower(name) || '|' || upper(team), computed the
-- same way client-side in js/players-data.js (window.playerKey).
-- ============================================================
create table public.rankings (
  owner_id   uuid not null references auth.users(id) on delete cascade,
  player_key text not null,
  rank       integer not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, player_key)
);

alter table public.rankings
  add constraint rankings_owner_rank_uniq unique (owner_id, rank) deferrable initially deferred;

alter table public.rankings enable row level security;

-- Visible to: the owner, admins with moderate_rankings, and anyone
-- (including signed-out visitors) when the owner is an editor/admin
-- whose role carries publish_official_rankings -- this is what makes
-- an Editor/Admin's saved rankings show up as a public Ranker option.
create policy rankings_select on public.rankings
  for select using (
    owner_id = auth.uid()
    or public.has_permission(auth.uid(), 'moderate_rankings')
    or public.has_permission(owner_id, 'publish_official_rankings')
  );

grant select on public.rankings to anon, authenticated;
-- No insert/update/delete grants for anon/authenticated: all writes
-- go through replace_user_rankings() below, which runs as the table
-- owner (security definer) and does its own permission + identity checks.

create or replace function public.replace_user_rankings(player_keys text[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if not public.has_permission(uid, 'create_edit_own_rankings') then
    raise exception 'not permitted';
  end if;
  if array_length(player_keys, 1) is null then
    raise exception 'player_keys must not be empty';
  end if;

  delete from public.rankings where owner_id = uid;

  insert into public.rankings (owner_id, player_key, rank, updated_at)
  select uid, pk, ord, now()
  from unnest(player_keys) with ordinality as t(pk, ord);
end;
$$;

grant execute on function public.replace_user_rankings(text[]) to authenticated;

-- ============================================================
-- login_attempts: backs the per-IP lockout enforced by the
-- "login" edge function. No RLS policies are added on purpose --
-- only the edge function (using the service-role key, which
-- bypasses RLS entirely) ever touches this table.
-- ============================================================
create table public.login_attempts (
  id         bigint generated always as identity primary key,
  ip         inet not null,
  identifier text,
  success    boolean not null,
  created_at timestamptz not null default now()
);

create index login_attempts_ip_time_idx on public.login_attempts (ip, created_at desc);
alter table public.login_attempts enable row level security;
-- (no policies -- deny-by-default for anon/authenticated)

-- ============================================================
-- handle_new_user: creates the profiles row whenever a new
-- auth.users row appears, whether from email/password sign-up
-- (username comes from raw_user_meta_data.username, set at
-- signUp time) or Google sign-in (name/avatar come from Google's
-- OAuth profile data, which Supabase copies into raw_user_meta_data).
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  base_username  text;
  final_username text;
  suffix         int := 0;
begin
  base_username := new.raw_user_meta_data->>'username';

  if base_username is null or base_username = '' then
    base_username := coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name');
    if base_username is not null then
      base_username := lower(regexp_replace(base_username, '[^a-zA-Z0-9]', '', 'g'));
    end if;
  end if;

  if base_username is null or base_username = '' then
    base_username := split_part(new.email, '@', 1);
  end if;

  base_username := lower(regexp_replace(base_username, '[^a-z0-9_]', '', 'g'));
  if base_username = '' then
    base_username := 'user';
  end if;

  final_username := base_username;
  while exists (select 1 from public.profiles where username = final_username) loop
    suffix := suffix + 1;
    final_username := base_username || suffix::text;
  end loop;

  insert into public.profiles (id, username, display_name, avatar_url, role)
  values (
    new.id,
    final_username,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', final_username),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
    'user'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- is_username_available: checked client-side before signUp() so
-- the sign-up form can show an inline "username taken" error
-- instead of failing after the auth user already exists.
-- ============================================================
create or replace function public.is_username_available(check_username text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select not exists (
    select 1 from public.profiles where lower(username) = lower(check_username)
  );
$$;

grant execute on function public.is_username_available(text) to anon, authenticated;

-- ============================================================
-- set_user_role: the only way a role is ever changed. Used by
-- the admin panel's user list.
-- ============================================================
create or replace function public.set_user_role(target_user uuid, new_role text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.has_permission(auth.uid(), 'manage_users') then
    raise exception 'not permitted';
  end if;
  if new_role not in ('user','editor','admin') then
    raise exception 'invalid role: %', new_role;
  end if;
  update public.profiles set role = new_role, updated_at = now() where id = target_user;
end;
$$;

grant execute on function public.set_user_role(uuid, text) to authenticated;

-- ============================================================
-- set_role_permission: the only way role_permissions is ever
-- changed. Used by the admin panel's policy matrix.
-- ============================================================
create or replace function public.set_role_permission(target_role text, target_permission text, is_allowed boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.has_permission(auth.uid(), 'manage_role_policies') then
    raise exception 'not permitted';
  end if;
  if target_role not in ('user','editor','admin') then
    raise exception 'invalid role: %', target_role;
  end if;

  insert into public.role_permissions (role, permission_key, allowed)
  values (target_role, target_permission, is_allowed)
  on conflict (role, permission_key) do update set allowed = excluded.allowed;
end;
$$;

grant execute on function public.set_role_permission(text, text, boolean) to authenticated;

-- ============================================================
-- admin_list_users: profiles + a couple of auth.users fields
-- (email, last_sign_in_at) that aren't otherwise readable by
-- anon/authenticated. Powers the admin panel's user table.
-- ============================================================
create or replace function public.admin_list_users()
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  role text,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select p.id, p.username, p.display_name, p.avatar_url, p.role,
         u.email, p.created_at, u.last_sign_in_at
    from public.profiles p
    join auth.users u on u.id = p.id
   where public.has_permission(auth.uid(), 'manage_users')
   order by p.created_at asc;
$$;

grant execute on function public.admin_list_users() to authenticated;

-- ============================================================
-- Seed permissions + default role policies
-- ============================================================
insert into public.permissions (key, description) values
  ('create_edit_own_rankings', 'Create and edit a personal player ranking on the Create/Edit Rankings page'),
  ('publish_official_rankings', 'Saved ranking appears as a public Ranker option on the main board'),
  ('view_admin_panel', 'Access the Admin panel'),
  ('manage_users', 'Change other users'' roles'),
  ('manage_role_policies', 'Add or remove permissions granted to each role'),
  ('moderate_rankings', 'View any user''s private rankings for moderation');

insert into public.role_permissions (role, permission_key, allowed) values
  ('user',   'create_edit_own_rankings',   true),
  ('editor', 'create_edit_own_rankings',   true),
  ('editor', 'publish_official_rankings',  true),
  ('admin',  'create_edit_own_rankings',   true),
  ('admin',  'publish_official_rankings',  true),
  ('admin',  'view_admin_panel',           true),
  ('admin',  'manage_users',               true),
  ('admin',  'manage_role_policies',       true),
  ('admin',  'moderate_rankings',          true);
