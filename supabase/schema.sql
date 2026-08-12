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
  subscription_tier text not null default 'free' check (subscription_tier in ('free','premium','elite','legendary')),
  username_changed_at timestamptz,
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
  -- subscription_tier is never touched by a plain UPDATE either (it's
  -- not in the column grant below) -- this is a second guard, same
  -- reasoning as role. Only set_my_subscription_tier() below can
  -- change it.
  if auth.uid() is not null
     and not exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') then
    new.subscription_tier := old.subscription_tier;
  end if;
  -- Username changes: once every 30 days, non-admins only (admins can
  -- always fix a username via the Admin panel / SQL editor). Raises
  -- instead of silently reverting so profile.html can show the actual
  -- reason -- unlike role/subscription_tier, a rejected username edit
  -- should be visible to the user, not swallowed.
  if new.username is distinct from old.username then
    if auth.uid() is not null
       and not exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
       and old.username_changed_at is not null
       and now() - old.username_changed_at < interval '30 days' then
      raise exception 'You can only change your username once every 30 days. Next change available %.',
        to_char(old.username_changed_at + interval '30 days', 'YYYY-MM-DD');
    end if;
    new.username_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger protect_profile_fields_trigger
  before update on public.profiles
  for each row execute procedure public.protect_profile_fields();

-- ============================================================
-- subscription_tier_limits / subscription_perks: the numbers behind
-- subscriptions.html's four plans (Free/Premium/Elite/Legendary) --
-- how many leagues a tier can link in My Teams, and how many free
-- expert-review credits (Start/Sit, Trade Analysis, Team Review)
-- each tier gets per week or month. Kept as data instead of
-- hardcoded logic so a plan change is a data edit, not a redeploy.
--
-- STUB: like Expert Reviews' checkout, there's no real Stripe
-- subscription billing yet -- set_my_subscription_tier() below just
-- sets the tier directly. See that function's comment for where a
-- real integration replaces it.
-- ============================================================
create table public.subscription_tier_limits (
  tier          text primary key check (tier in ('free','premium','elite','legendary')),
  league_limit  integer not null
);

insert into public.subscription_tier_limits (tier, league_limit) values
  ('free', 3),
  ('premium', 10),
  ('elite', 15),
  ('legendary', 25);

create table public.subscription_perks (
  tier        text not null check (tier in ('free','premium','elite','legendary')),
  review_type text not null check (review_type in ('team_review','trade_analysis','start_sit')),
  period      text not null check (period in ('week','month')),
  quota       integer not null,
  primary key (tier, review_type)
);

insert into public.subscription_perks (tier, review_type, period, quota) values
  ('free',      'start_sit',      'month', 1),
  ('premium',   'start_sit',      'week',  1),
  ('premium',   'trade_analysis', 'week',  1),
  ('premium',   'team_review',    'month', 1),
  ('elite',     'start_sit',      'week',  2),
  ('elite',     'trade_analysis', 'week',  2),
  ('elite',     'team_review',    'week',  2),
  ('legendary', 'start_sit',      'week',  4),
  ('legendary', 'trade_analysis', 'week',  4),
  ('legendary', 'team_review',    'week',  3);

alter table public.subscription_tier_limits enable row level security;
alter table public.subscription_perks enable row level security;
create policy subscription_tier_limits_select_all on public.subscription_tier_limits for select using (true);
create policy subscription_perks_select_all on public.subscription_perks for select using (true);
grant select on public.subscription_tier_limits to anon, authenticated;
grant select on public.subscription_perks to anon, authenticated;

create or replace function public.set_my_subscription_tier(new_tier text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if new_tier not in ('free','premium','elite','legendary') then
    raise exception 'invalid tier: %', new_tier;
  end if;
  -- STUB: a real integration would create a Stripe Checkout Session
  -- (subscription mode) here instead of setting the tier immediately,
  -- and only apply it from a webhook once the subscription is active.
  update public.profiles set subscription_tier = new_tier, updated_at = now() where id = auth.uid();
end;
$$;

grant execute on function public.set_my_subscription_tier(text) to authenticated;

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
  my_tier text;
  perk record;
  period_start timestamptz;
  used_this_period integer;
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

  -- Subscription free credits (subscriptions.html's per-tier perks,
  -- e.g. Premium's "1x Trade Analysis per week (Free)"). personal_coach
  -- isn't part of any tier's perks, so it always costs full price.
  select subscription_tier into my_tier from public.profiles where id = uid;
  select * into perk from public.subscription_perks where tier = my_tier and review_type = p_review_type;
  if found then
    period_start := case perk.period when 'week' then now() - interval '7 days' else now() - interval '1 month' end;
    select count(*) into used_this_period
      from public.expert_review_requests
     where user_id = uid and review_type = p_review_type and price_cents = 0 and created_at >= period_start;
    if used_this_period < perk.quota then
      price := 0;
    end if;
  end if;

  -- STUB: this is where a real integration would instead create a
  -- Stripe Checkout Session (probably via an edge function, since the
  -- Stripe secret key can't live in client code) and only insert this
  -- row -- with status='pending_payment' -- once that session exists,
  -- flipping it to 'submitted' from a webhook after payment succeeds.
  -- (Free-credit requests from the block above have nothing to charge,
  -- so those still go straight to 'submitted'.)
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
-- fantasy_teams: leagues a user has linked from Sleeper or ESPN
-- for my-teams.html. Sleeper and ESPN's (unofficial but public)
-- APIs are both CORS-open and fetched directly client-side from
-- js/fantasy-platforms.js -- this table only stores enough to know
-- what to fetch: the league id, and for private ESPN leagues, the
-- espn_s2/SWID session cookie values the user pastes in themselves.
-- Yahoo isn't here yet -- it needs a registered Yahoo OAuth app
-- that doesn't exist. Ordering is just created_at asc, so teams
-- stay in the order they were added, never reshuffled.
-- ============================================================
create table public.fantasy_teams (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  platform   text not null check (platform in ('sleeper','espn')),
  league_id  text not null,
  season     text,
  label      text,
  espn_swid  text,
  espn_s2    text,
  created_at timestamptz not null default now()
);

create index fantasy_teams_owner_idx on public.fantasy_teams (owner_id, created_at);
alter table public.fantasy_teams enable row level security;

create policy fantasy_teams_select on public.fantasy_teams
  for select using (owner_id = auth.uid());

create policy fantasy_teams_update on public.fantasy_teams
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy fantasy_teams_delete on public.fantasy_teams
  for delete using (owner_id = auth.uid());

-- Insert additionally enforces the caller's subscription tier's
-- league_limit (subscription_tier_limits) -- "Supports N leagues" on
-- subscriptions.html.
create policy fantasy_teams_insert on public.fantasy_teams
  for insert with check (
    owner_id = auth.uid()
    and (select count(*) from public.fantasy_teams where owner_id = auth.uid())
        < (
          select stl.league_limit
            from public.subscription_tier_limits stl
            join public.profiles p on p.subscription_tier = stl.tier
           where p.id = auth.uid()
        )
  );

grant select, insert, update, delete on public.fantasy_teams to authenticated;

-- ============================================================
-- analyzed_trades: a lightweight log of trades run through
-- trade-analyzer.html, shown back as a "recent trades" feed on that
-- page. FantasyCalc (whose player values power the trade math) has
-- no public "recent trades" database to pull from, so this is our
-- own equivalent built from real usage -- every trade with at least
-- one player on each side is logged automatically, publicly, under
-- the submitter's username if signed in.
-- ============================================================
create table public.analyzed_trades (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete set null,
  side_a       jsonb not null,
  side_b       jsonb not null,
  side_a_value integer not null,
  side_b_value integer not null,
  verdict      text not null,
  created_at   timestamptz not null default now()
);

create index analyzed_trades_created_idx on public.analyzed_trades (created_at desc);
alter table public.analyzed_trades enable row level security;

create policy analyzed_trades_select_all on public.analyzed_trades
  for select using (true);

create policy analyzed_trades_insert on public.analyzed_trades
  for insert with check (
    user_id = auth.uid() and public.has_permission(auth.uid(), 'log_analyzed_trades')
  );

grant select on public.analyzed_trades to anon, authenticated;
grant insert on public.analyzed_trades to authenticated;

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
-- posts: the Posts page. category is a fixed set shown as filter
-- pills; subscriber_only marks a post as gated by subscription
-- (blurred client-side for non-subscribers -- the body itself is
-- still readable by anyone with select access, same tradeoff as
-- avatar_url being a plain pasted URL rather than real storage).
--
-- "Experts" here means the editor role, same as everywhere else in
-- this schema (create_edit_own_rankings, publish_official_rankings)
-- -- there's no separate 'expert' role. create_posts lets an
-- expert/admin write drafts; only publish_posts (admin by default)
-- can flip status, enforced by protect_post_status() below the same
-- way protect_profile_fields() guards role; delete_posts (admin by
-- default) is the only way a post can be deleted at all.
-- ============================================================
create table public.posts (
  id               uuid primary key default gen_random_uuid(),
  author_id        uuid not null references auth.users(id) on delete cascade,
  title            text not null,
  category         text not null check (category in (
    'game_review','week_review','injury_report','trade_targets','drafts','articles'
  )),
  thumbnail_url    text,
  video_url        text,
  excerpt          text,
  body             text not null,
  subscriber_only  boolean not null default false,
  status           text not null default 'draft' check (status in ('draft','published')),
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index posts_status_created_idx on public.posts (status, created_at desc);
alter table public.posts enable row level security;

create policy posts_select on public.posts
  for select using (
    status = 'published'
    or author_id = auth.uid()
    or public.has_permission(auth.uid(), 'publish_posts')
  );

create policy posts_insert on public.posts
  for insert with check (author_id = auth.uid() and public.has_permission(auth.uid(), 'create_posts'));

create policy posts_update on public.posts
  for update
  using (author_id = auth.uid() or public.has_permission(auth.uid(), 'publish_posts'))
  with check (author_id = auth.uid() or public.has_permission(auth.uid(), 'publish_posts'));

create policy posts_delete on public.posts
  for delete using (public.has_permission(auth.uid(), 'delete_posts'));

grant select, insert, update, delete on public.posts to authenticated;
grant select on public.posts to anon;

-- Guards status on BOTH insert and update -- an insert that tries to
-- set status='published' directly (skipping the publish_posts check
-- entirely) is just as much a hole as an update that does the same.
create or replace function public.protect_post_status()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'published'
       and auth.uid() is not null
       and not public.has_permission(auth.uid(), 'publish_posts') then
      new.status := 'draft';
    end if;
    if new.status = 'published' then
      new.published_at := now();
    end if;
  else
    if new.status is distinct from old.status
       and auth.uid() is not null
       and not public.has_permission(auth.uid(), 'publish_posts') then
      new.status := old.status;
    end if;
    if new.status = 'published' and old.status is distinct from new.status then
      new.published_at := now();
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger protect_post_status_trigger
  before insert or update on public.posts
  for each row execute procedure public.protect_post_status();

-- ============================================================
-- player_notes: the free-text note shown in the player detail
-- modal (Rankings, Create/Edit Rankings, Trade Analyzer). One row
-- per player_key (same key computed by window.playerKey), editable
-- by anyone with edit_player_notes (editor/admin by default),
-- readable by everyone.
-- ============================================================
create table public.player_notes (
  player_key text primary key,
  notes      text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.player_notes enable row level security;

create policy player_notes_select_all on public.player_notes for select using (true);

create policy player_notes_upsert on public.player_notes
  for insert with check (public.has_permission(auth.uid(), 'edit_player_notes'));

create policy player_notes_update on public.player_notes
  for update using (public.has_permission(auth.uid(), 'edit_player_notes'))
  with check (public.has_permission(auth.uid(), 'edit_player_notes'));

grant select on public.player_notes to anon, authenticated;
grant insert, update on public.player_notes to authenticated;

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
  ('manage_expert_reviews', 'View, respond to, and resend paid expert review requests'),
  ('log_analyzed_trades', 'Save an analyzed trade to the public Recent Trades feed on the Trade Analyzer'),
  ('create_posts', 'Create and edit draft posts on the Posts page'),
  ('publish_posts', 'Publish or unpublish any post'),
  ('delete_posts', 'Delete any post'),
  ('edit_player_notes', 'Edit the notes shown in a player''s detail card');

insert into public.role_permissions (role, permission_key, allowed) values
  ('user',   'create_edit_own_rankings',   true),
  ('editor', 'create_edit_own_rankings',   true),
  ('editor', 'publish_official_rankings',  true),
  ('editor', 'log_analyzed_trades',        true),
  ('editor', 'create_posts',               true),
  ('editor', 'edit_player_notes',          true),
  ('admin',  'create_edit_own_rankings',   true),
  ('admin',  'publish_official_rankings',  true),
  ('admin',  'view_admin_panel',           true),
  ('admin',  'manage_users',               true),
  ('admin',  'manage_role_policies',       true),
  ('admin',  'moderate_rankings',          true),
  ('admin',  'manage_expert_reviews',      true),
  ('admin',  'log_analyzed_trades',        true),
  ('admin',  'create_posts',               true),
  ('admin',  'publish_posts',              true),
  ('admin',  'delete_posts',               true),
  ('admin',  'edit_player_notes',          true);

-- ============================================================
-- Mock Drafts (mock-draft.html / mock-draft-room.html)
--
-- Multiple rooms run concurrently, each with a fixed number of
-- draft slots (team_count), filled by real users and/or bots,
-- picking in snake or linear order on a per-pick timer. A room is
-- either public (listed in the lobby, joinable by anyone) or
-- private (joinable only by whoever has its invite_code/link).
--
-- Player data (window.__PLAYERS__ / js/players-data.js) lives only
-- in static client JS, not in Postgres -- there is no `players`
-- table. That means "who's the best player available" can only be
-- computed client-side, so autopick works differently from a normal
-- security-definer RPC: the client (whichever browser notices a
-- deadline has passed, or that a bot is on the clock) computes the
-- best available player itself and calls mock_draft_make_pick() with
-- is_autopick=true; the RPC re-validates server-side that autopick
-- was actually legitimate (bot's turn, or the deadline truly passed)
-- before accepting it -- the client chooses *which* player, the
-- server is still the one deciding *whether* that pick is allowed.
-- Concurrent clients racing to autopick the same slot is expected
-- and harmless: mock_draft_make_pick() locks the room row (`for
-- update`) for its duration, so only the first caller's pick applies
-- and every other racing call fails on "not your turn" / "already
-- drafted" -- the client-side caller of autopick is expected to
-- swallow that failure silently rather than surface it as an error.
--
-- Access model is intentionally loose (like analyzed_trades):
-- anyone can SELECT any room/slot/pick row if they know its id
-- (practically gated by invite_code + not being listed for private
-- rooms), since this is a low-stakes feature with nothing sensitive
-- in it. All writes go through the RPCs below.
-- ============================================================
create table public.mock_draft_rooms (
  id            uuid primary key default gen_random_uuid(),
  host_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  team_count    integer not null check (team_count between 4 and 14),
  rounds        integer not null check (rounds between 1 and 20),
  pick_seconds  integer not null default 60 check (pick_seconds between 15 and 300),
  draft_type    text not null default 'snake' check (draft_type in ('snake','linear')),
  is_public     boolean not null default false,
  invite_code   text not null unique default substr(md5(random()::text), 1, 8),
  status        text not null default 'waiting' check (status in ('waiting','in_progress','completed')),
  current_pick  integer not null default 1,
  pick_deadline timestamptz,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index mock_draft_rooms_public_idx on public.mock_draft_rooms (is_public, status, created_at desc);
alter table public.mock_draft_rooms enable row level security;
create policy mock_draft_rooms_select_all on public.mock_draft_rooms for select using (true);
grant select on public.mock_draft_rooms to anon, authenticated;

create table public.mock_draft_slots (
  room_id     uuid not null references public.mock_draft_rooms(id) on delete cascade,
  slot_index  integer not null,
  user_id     uuid references auth.users(id) on delete set null,
  team_label  text not null,
  is_bot      boolean not null default false,
  joined_at   timestamptz not null default now(),
  primary key (room_id, slot_index)
);
alter table public.mock_draft_slots enable row level security;
create policy mock_draft_slots_select_all on public.mock_draft_slots for select using (true);
grant select on public.mock_draft_slots to anon, authenticated;

create table public.mock_draft_picks (
  room_id     uuid not null references public.mock_draft_rooms(id) on delete cascade,
  pick_number integer not null,
  round       integer not null,
  slot_index  integer not null,
  player_key  text not null,
  player_name text not null,
  picked_at   timestamptz not null default now(),
  primary key (room_id, pick_number)
);
alter table public.mock_draft_picks enable row level security;
create policy mock_draft_picks_select_all on public.mock_draft_picks for select using (true);
grant select on public.mock_draft_picks to anon, authenticated;

-- Pure function: given a room's team_count/draft_type, which round
-- and slot is on the clock for a given overall pick number. Shared by
-- mock_draft_make_pick() (this pick) and start/advance (the next
-- pick's deadline needs to know if the next slot is a bot).
create or replace function public.mock_draft_slot_for_pick(p_team_count integer, p_draft_type text, p_pick_number integer)
returns table(round integer, slot_index integer)
language sql immutable
as $$
  select
    ((p_pick_number - 1) / p_team_count) + 1 as round,
    case
      when p_draft_type = 'snake' and (((p_pick_number - 1) / p_team_count) + 1) % 2 = 0
        then p_team_count - (((p_pick_number - 1) % p_team_count) + 1) + 1
      else ((p_pick_number - 1) % p_team_count) + 1
    end as slot_index;
$$;

create or replace function public.create_mock_draft_room(
  p_name text,
  p_team_count integer,
  p_rounds integer,
  p_pick_seconds integer,
  p_draft_type text,
  p_is_public boolean
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  new_room_id uuid;
  host_label text;
  i integer;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if p_team_count is null or p_team_count < 4 or p_team_count > 14 then
    raise exception 'team_count must be between 4 and 14';
  end if;
  if p_rounds is null or p_rounds < 1 or p_rounds > 20 then
    raise exception 'rounds must be between 1 and 20';
  end if;
  if p_draft_type not in ('snake', 'linear') then
    raise exception 'invalid draft_type: %', p_draft_type;
  end if;

  select coalesce(display_name, username) into host_label from public.profiles where id = uid;

  insert into public.mock_draft_rooms (host_id, name, team_count, rounds, pick_seconds, draft_type, is_public)
  values (uid, coalesce(nullif(trim(p_name), ''), host_label || '''s Mock Draft'), p_team_count, p_rounds,
          greatest(15, least(300, coalesce(p_pick_seconds, 60))), p_draft_type, coalesce(p_is_public, false))
  returning id into new_room_id;

  for i in 1..p_team_count loop
    insert into public.mock_draft_slots (room_id, slot_index, team_label)
    values (new_room_id, i, 'Team ' || i);
  end loop;

  -- host automatically takes slot 1
  update public.mock_draft_slots set user_id = uid, team_label = coalesce(host_label, 'Team 1')
  where room_id = new_room_id and slot_index = 1;

  return new_room_id;
end;
$$;

grant execute on function public.create_mock_draft_room(text, integer, integer, integer, text, boolean) to authenticated;

create or replace function public.join_mock_draft_room(p_room_id uuid, p_invite_code text, p_slot_index integer default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  room record;
  target_slot integer;
  user_label text;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select * into room from public.mock_draft_rooms where id = p_room_id for update;
  if not found then
    raise exception 'room not found';
  end if;
  if room.invite_code is distinct from p_invite_code then
    raise exception 'invalid invite code';
  end if;
  if room.status <> 'waiting' then
    raise exception 'this draft has already started';
  end if;

  if exists (select 1 from public.mock_draft_slots where room_id = p_room_id and user_id = uid) then
    raise exception 'you are already in this room';
  end if;

  if p_slot_index is not null then
    if not exists (select 1 from public.mock_draft_slots where room_id = p_room_id and slot_index = p_slot_index and user_id is null and is_bot = false) then
      raise exception 'that slot is not open';
    end if;
    target_slot := p_slot_index;
  else
    select slot_index into target_slot from public.mock_draft_slots
      where room_id = p_room_id and user_id is null and is_bot = false
      order by slot_index limit 1;
    if target_slot is null then
      raise exception 'this room is full';
    end if;
  end if;

  select coalesce(display_name, username) into user_label from public.profiles where id = uid;

  update public.mock_draft_slots set user_id = uid, is_bot = false, team_label = coalesce(user_label, 'Team ' || target_slot)
  where room_id = p_room_id and slot_index = target_slot;

  return target_slot;
end;
$$;

grant execute on function public.join_mock_draft_room(uuid, text, integer) to authenticated;

create or replace function public.leave_mock_draft_room(p_room_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  update public.mock_draft_slots set user_id = null, team_label = 'Team ' || slot_index
  where room_id = p_room_id and user_id = uid
    and exists (select 1 from public.mock_draft_rooms r where r.id = p_room_id and r.status = 'waiting');
end;
$$;

grant execute on function public.leave_mock_draft_room(uuid) to authenticated;

create or replace function public.set_mock_draft_slot_bot(p_room_id uuid, p_slot_index integer, p_is_bot boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.mock_draft_rooms where id = p_room_id and host_id = uid and status = 'waiting') then
    raise exception 'only the host can do that, and only before the draft starts';
  end if;
  update public.mock_draft_slots
     set is_bot = p_is_bot,
         user_id = case when p_is_bot then null else user_id end,
         team_label = case when p_is_bot then 'Bot ' || slot_index else team_label end
   where room_id = p_room_id and slot_index = p_slot_index;
end;
$$;

grant execute on function public.set_mock_draft_slot_bot(uuid, integer, boolean) to authenticated;

create or replace function public.start_mock_draft(p_room_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  room record;
  first_slot record;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into room from public.mock_draft_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if room.host_id <> uid then raise exception 'only the host can start the draft'; end if;
  if room.status <> 'waiting' then raise exception 'this draft has already started'; end if;

  -- auto-fill any still-empty seats as bots so the host never has to wait on stragglers
  update public.mock_draft_slots
     set is_bot = true, team_label = 'Bot ' || slot_index
   where room_id = p_room_id and user_id is null and is_bot = false;

  select * into first_slot from public.mock_draft_slots where room_id = p_room_id and slot_index = 1;

  update public.mock_draft_rooms
     set status = 'in_progress', started_at = now(), current_pick = 1,
         pick_deadline = now() + (case when first_slot.is_bot then interval '4 seconds' else make_interval(secs => room.pick_seconds) end)
   where id = p_room_id;
end;
$$;

grant execute on function public.start_mock_draft(uuid) to authenticated;

-- The only way a pick is ever written. Handles both a human picking
-- on their own turn and an autopick (bot's turn, or a human's
-- deadline expired) -- see the block comment above this section for
-- why the *choice* of player has to come from the client.
create or replace function public.mock_draft_make_pick(
  p_room_id uuid,
  p_player_key text,
  p_player_name text,
  p_is_autopick boolean default false
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  room record;
  slot_info record;
  on_clock record;
  next_pick integer;
  next_slot_info record;
  next_on_clock record;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into room from public.mock_draft_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if room.status <> 'in_progress' then raise exception 'this draft is not in progress'; end if;

  select * into slot_info from public.mock_draft_slot_for_pick(room.team_count, room.draft_type, room.current_pick);
  select * into on_clock from public.mock_draft_slots where room_id = p_room_id and slot_index = slot_info.slot_index;

  if p_is_autopick then
    if not (on_clock.is_bot or now() >= room.pick_deadline) then
      raise exception 'autopick is not available yet';
    end if;
  else
    if on_clock.is_bot or on_clock.user_id is distinct from uid then
      raise exception 'it is not your turn';
    end if;
  end if;

  if exists (select 1 from public.mock_draft_picks where room_id = p_room_id and player_key = p_player_key) then
    raise exception 'that player has already been drafted';
  end if;

  insert into public.mock_draft_picks (room_id, pick_number, round, slot_index, player_key, player_name)
  values (p_room_id, room.current_pick, slot_info.round, slot_info.slot_index, p_player_key, p_player_name);

  next_pick := room.current_pick + 1;

  if next_pick > room.team_count * room.rounds then
    update public.mock_draft_rooms set status = 'completed', completed_at = now(), current_pick = next_pick where id = p_room_id;
  else
    select * into next_slot_info from public.mock_draft_slot_for_pick(room.team_count, room.draft_type, next_pick);
    select * into next_on_clock from public.mock_draft_slots where room_id = p_room_id and slot_index = next_slot_info.slot_index;
    update public.mock_draft_rooms
       set current_pick = next_pick,
           pick_deadline = now() + (case when next_on_clock.is_bot then interval '4 seconds' else make_interval(secs => room.pick_seconds) end)
     where id = p_room_id;
  end if;
end;
$$;

grant execute on function public.mock_draft_make_pick(uuid, text, text, boolean) to authenticated;
