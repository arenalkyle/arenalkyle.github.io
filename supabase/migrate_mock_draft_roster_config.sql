-- ============================================================
-- One-time migration: adds scoring_format + roster construction to
-- an EXISTING live mock_draft_rooms table, and locks team_count down
-- to 6/8/10/12/14/16.
--
-- Context: the Mock Drafts tables/RPCs in schema.sql were already
-- live on this project (schema.sql's "has not been run yet" comment
-- was stale/wrong -- see the fixed comment there). This migration
-- brings an already-live database up to match the current
-- create_mock_draft_room signature and mock_draft_rooms shape in
-- schema.sql. Run this ONCE in the Supabase SQL editor.
--
-- Safe to run even if some pieces already match (constraint drops are
-- pattern-matched by column rather than by a guessed constraint name,
-- and column adds use IF NOT EXISTS).
-- ============================================================

-- 1. Re-point the team_count check constraint at the new fixed set of
--    sizes (was "between 4 and 14"). Constraint name isn't assumed --
--    found by inspecting its definition instead.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.mock_draft_rooms'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%team_count%'
  loop
    execute format('alter table public.mock_draft_rooms drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.mock_draft_rooms
  add constraint mock_draft_rooms_team_count_check check (team_count in (6, 8, 10, 12, 14, 16));

-- 2. Widen the rounds check constraint (was "between 1 and 20") to
--    accommodate larger roster constructions.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.mock_draft_rooms'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%rounds%'
  loop
    execute format('alter table public.mock_draft_rooms drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.mock_draft_rooms
  add constraint mock_draft_rooms_rounds_check check (rounds between 1 and 30);

-- 3. New columns: scoring format + roster construction.
alter table public.mock_draft_rooms
  add column if not exists scoring_format text not null default 'ppr' check (scoring_format in ('ppr','half_ppr','tep','superflex')),
  add column if not exists roster_qb     integer not null default 1 check (roster_qb between 0 and 4),
  add column if not exists roster_rb     integer not null default 2 check (roster_rb between 0 and 6),
  add column if not exists roster_wr     integer not null default 2 check (roster_wr between 0 and 6),
  add column if not exists roster_te     integer not null default 1 check (roster_te between 0 and 4),
  add column if not exists roster_flex   integer not null default 1 check (roster_flex between 0 and 4),
  add column if not exists roster_dst    integer not null default 1 check (roster_dst between 0 and 2),
  add column if not exists roster_k      integer not null default 1 check (roster_k between 0 and 2),
  add column if not exists roster_bench  integer not null default 6 check (roster_bench between 0 and 12);

-- 4. create_mock_draft_room's signature changed (p_rounds removed,
--    scoring_format + roster params added) -- CREATE OR REPLACE can't
--    change a function's argument list, so the old one has to be
--    dropped explicitly first or PostgREST ends up with two
--    overloads and "could not choose the best candidate function".
drop function if exists public.create_mock_draft_room(text, integer, integer, integer, text, boolean);

create or replace function public.create_mock_draft_room(
  p_name text,
  p_team_count integer,
  p_pick_seconds integer,
  p_draft_type text,
  p_is_public boolean,
  p_scoring_format text default 'ppr',
  p_roster_qb integer default 1,
  p_roster_rb integer default 2,
  p_roster_wr integer default 2,
  p_roster_te integer default 1,
  p_roster_flex integer default 1,
  p_roster_dst integer default 1,
  p_roster_k integer default 1,
  p_roster_bench integer default 6
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  new_room_id uuid;
  host_label text;
  i integer;
  total_rounds integer;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if p_team_count is null or p_team_count not in (6, 8, 10, 12, 14, 16) then
    raise exception 'team_count must be one of 6, 8, 10, 12, 14, 16';
  end if;
  if p_draft_type not in ('snake', 'linear') then
    raise exception 'invalid draft_type: %', p_draft_type;
  end if;
  if p_scoring_format not in ('ppr', 'half_ppr', 'tep', 'superflex') then
    raise exception 'invalid scoring_format: %', p_scoring_format;
  end if;

  total_rounds := coalesce(p_roster_qb, 0) + coalesce(p_roster_rb, 0) + coalesce(p_roster_wr, 0)
    + coalesce(p_roster_te, 0) + coalesce(p_roster_flex, 0) + coalesce(p_roster_dst, 0)
    + coalesce(p_roster_k, 0) + coalesce(p_roster_bench, 0);
  if total_rounds < 1 or total_rounds > 30 then
    raise exception 'roster construction must total between 1 and 30 rounds';
  end if;

  select coalesce(display_name, username) into host_label from public.profiles where id = uid;

  insert into public.mock_draft_rooms (
    host_id, name, team_count, rounds, pick_seconds, draft_type, is_public, scoring_format,
    roster_qb, roster_rb, roster_wr, roster_te, roster_flex, roster_dst, roster_k, roster_bench
  )
  values (
    uid, coalesce(nullif(trim(p_name), ''), host_label || '''s Mock Draft'), p_team_count, total_rounds,
    greatest(15, least(300, coalesce(p_pick_seconds, 60))), p_draft_type, coalesce(p_is_public, false), p_scoring_format,
    coalesce(p_roster_qb, 1), coalesce(p_roster_rb, 2), coalesce(p_roster_wr, 2), coalesce(p_roster_te, 1),
    coalesce(p_roster_flex, 1), coalesce(p_roster_dst, 1), coalesce(p_roster_k, 1), coalesce(p_roster_bench, 6)
  )
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

grant execute on function public.create_mock_draft_room(text, integer, integer, text, boolean, text, integer, integer, integer, integer, integer, integer, integer, integer) to authenticated;
