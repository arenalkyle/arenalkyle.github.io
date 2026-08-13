-- ============================================================
-- One-time migration: adds a server-side "autopick" flag per draft
-- slot, and a host-only way to end a draft early. Run ONCE in the
-- Supabase SQL editor against a database that already has the Mock
-- Drafts tables/RPCs live (see the note above the Mock Drafts section
-- in schema.sql for why this can't just be folded into a CREATE
-- TABLE there).
--
-- Why autopick has to be server-side: the client that ends up running
-- mock_draft_make_pick(is_autopick=true) for a given turn might be any
-- connected browser, not necessarily the on-the-clock user's own (see
-- the big comment above the Mock Drafts section) -- so "should this
-- slot autodraft immediately instead of waiting out the full timer"
-- has to be readable by every client, which means it has to live on
-- mock_draft_slots, not in one browser's localStorage.
-- ============================================================

alter table public.mock_draft_slots add column if not exists autopick boolean not null default false;

create or replace function public.set_mock_draft_autopick(p_room_id uuid, p_enabled boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  update public.mock_draft_slots set autopick = p_enabled
  where room_id = p_room_id and user_id = uid;
  if not found then
    raise exception 'you are not seated in this room';
  end if;
end;
$$;

grant execute on function public.set_mock_draft_autopick(uuid, boolean) to authenticated;

-- Same signature as the live version -- CREATE OR REPLACE is safe
-- here (no DROP needed, unlike create_mock_draft_room's migration).
-- Only change: a human who lets their own deadline lapse has their
-- slot's autopick flipped on as a side effect, so future turns for
-- them autodraft immediately instead of stalling the room again.
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
    if not (on_clock.is_bot or on_clock.autopick or now() >= room.pick_deadline) then
      raise exception 'autopick is not available yet';
    end if;
    if not on_clock.is_bot and not on_clock.autopick and now() >= room.pick_deadline then
      update public.mock_draft_slots set autopick = true where room_id = p_room_id and slot_index = slot_info.slot_index;
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
           pick_deadline = now() + (case when (next_on_clock.is_bot or next_on_clock.autopick) then interval '4 seconds' else make_interval(secs => room.pick_seconds) end)
     where id = p_room_id;
  end if;
end;
$$;

grant execute on function public.mock_draft_make_pick(uuid, text, text, boolean) to authenticated;

-- Host-only escape hatch for a room nobody is going to finish (e.g.
-- everyone left). Ends it in place with whatever picks happened so
-- far rather than leaving it stuck showing "Live" forever in the
-- lobby with nothing left to advance it (there's no server-side
-- cron -- see the Mock Drafts block comment in schema.sql).
create or replace function public.end_mock_draft_room(p_room_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  room record;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into room from public.mock_draft_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if room.host_id <> uid then raise exception 'only the host can end this draft'; end if;
  if room.status = 'completed' then return; end if;
  update public.mock_draft_rooms set status = 'completed', completed_at = now() where id = p_room_id;
end;
$$;

grant execute on function public.end_mock_draft_room(uuid) to authenticated;
