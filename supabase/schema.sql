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
-- notifications: short messages surfaced in the account menu,
-- e.g. "your expert review is ready." Written only by trusted
-- server-side code (security-definer RPCs like
-- admin_respond_expert_review below) -- users can only read their
-- own and mark them read, never insert or write anything else.
-- ============================================================
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text not null,
  body       text,
  link       text,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;

create policy notifications_select_own on public.notifications
  for select using (user_id = auth.uid());

create policy notifications_update_own on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on public.notifications to authenticated;
grant update (read) on public.notifications to authenticated;
-- no insert grant -- rows only ever come from security-definer RPCs.

-- ============================================================
-- expert_review_requests: paid review requests (Team Review /
-- Trade Analysis / Start-Sit / Personal Coach) users submit from
-- expert-reviews.html, and experts/admins (has_permission
-- 'manage_expert_reviews') work through from expert-reviews.html's
-- queue and expert-reviews-log.html.
--
-- STUB: there is no Stripe integration yet. A real checkout would
-- create a Stripe Checkout Session and this row would start life as
-- status='pending_payment' until a webhook confirmed the charge --
-- see the comment inside submit_expert_review() below for exactly
-- where that needs to go. Until then every request is recorded as
-- already 'submitted', unpaid, the moment the form is filled out.
-- ============================================================
create table public.expert_review_requests (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  review_type        text not null check (review_type in ('team_review','trade_analysis','start_sit','personal_coach')),
  tier               text,
  price_cents        integer not null,
  team_name          text,
  payload            jsonb not null default '{}',
  notes              text,
  status             text not null default 'submitted' check (status in ('submitted','in_review','completed')),
  assigned_expert_id uuid references auth.users(id),
  response           text,
  responded_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index expert_review_requests_created_idx on public.expert_review_requests (created_at desc);
alter table public.expert_review_requests enable row level security;

create policy expert_review_requests_select on public.expert_review_requests
  for select using (
    user_id = auth.uid()
    or public.has_permission(auth.uid(), 'manage_expert_reviews')
  );

grant select on public.expert_review_requests to authenticated;
-- all writes go through the RPCs below.

create or replace function public.submit_expert_review(
  p_review_type text,
  p_tier text,
  p_team_name text,
  p_payload jsonb,
  p_notes text
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  price integer;
  new_id uuid;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  price := case p_review_type
    when 'team_review' then 500
    when 'trade_analysis' then 100
    when 'start_sit' then 100
    when 'personal_coach' then case when p_tier = '25' then 2500 else 1000 end
    else null
  end;
  if price is null then
    raise exception 'invalid review_type: %', p_review_type;
  end if;

  -- STUB: this is where a real integration would instead create a
  -- Stripe Checkout Session (probably via an edge function, since the
  -- Stripe secret key can't live in client code) and only insert this
  -- row -- with status='pending_payment' -- once that session exists,
  -- flipping it to 'submitted' from a webhook after payment succeeds.
  insert into public.expert_review_requests (user_id, review_type, tier, price_cents, team_name, payload, notes)
  values (uid, p_review_type, p_tier, price, p_team_name, coalesce(p_payload, '{}'), p_notes)
  returning id into new_id;

  return new_id;
end;
$$;

grant execute on function public.submit_expert_review(text, text, text, jsonb, text) to authenticated;

-- ============================================================
-- admin_list_expert_reviews: powers both the "incoming requests"
-- queue on expert-reviews.html and the full history table on
-- expert-reviews-log.html. Search matches username or email, same
-- pattern as admin_list_users.
-- ============================================================
create or replace function public.admin_list_expert_reviews(search text default null)
returns table (
  id uuid,
  username text,
  email text,
  review_type text,
  tier text,
  price_cents integer,
  team_name text,
  payload jsonb,
  notes text,
  status text,
  assigned_expert_username text,
  response text,
  responded_at timestamptz,
  created_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select r.id, p.username, u.email, r.review_type, r.tier, r.price_cents, r.team_name,
         r.payload, r.notes, r.status, ep.username, r.response, r.responded_at, r.created_at
    from public.expert_review_requests r
    join public.profiles p on p.id = r.user_id
    join auth.users u on u.id = r.user_id
    left join public.profiles ep on ep.id = r.assigned_expert_id
   where public.has_permission(auth.uid(), 'manage_expert_reviews')
     and (
       search is null or search = ''
       or p.username ilike '%' || search || '%'
       or u.email ilike '%' || search || '%'
     )
   order by r.created_at desc;
$$;

grant execute on function public.admin_list_expert_reviews(text) to authenticated;

-- ============================================================
-- admin_respond_expert_review: the only way a request's response is
-- ever written. Used both for the first reply (status starts
-- 'submitted') and for editing + resending an already-completed one
-- from expert-reviews-log.html -- either way it stamps the calling
-- expert as assigned_expert_id (so replies are never anonymous) and
-- fires a fresh notification to the requester.
-- ============================================================
create or replace function public.admin_respond_expert_review(
  p_request_id uuid,
  p_response text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  target_user uuid;
begin
  if not public.has_permission(auth.uid(), 'manage_expert_reviews') then
    raise exception 'not permitted';
  end if;

  update public.expert_review_requests
     set response = p_response,
         status = 'completed',
         assigned_expert_id = auth.uid(),
         responded_at = now(),
         updated_at = now()
   where id = p_request_id
   returning user_id into target_user;

  if target_user is null then
    raise exception 'request not found';
  end if;

  insert into public.notifications (user_id, title, body, link)
  values (target_user, 'Your expert review is ready', coalesce(p_response, ''), 'expert-reviews.html');
end;
$$;

grant execute on function public.admin_respond_expert_review(uuid, text) to authenticated;

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
  ('moderate_rankings', 'View any user''s private rankings for moderation'),
  ('manage_expert_reviews', 'View, respond to, and resend paid expert review requests');

insert into public.role_permissions (role, permission_key, allowed) values
  ('user',   'create_edit_own_rankings',   true),
  ('editor', 'create_edit_own_rankings',   true),
  ('editor', 'publish_official_rankings',  true),
  ('admin',  'create_edit_own_rankings',   true),
  ('admin',  'publish_official_rankings',  true),
  ('admin',  'view_admin_panel',           true),
  ('admin',  'manage_users',               true),
  ('admin',  'manage_role_policies',       true),
  ('admin',  'moderate_rankings',          true),
  ('admin',  'manage_expert_reviews',      true);
