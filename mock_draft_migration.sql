-- ============================================================
-- One-time migration: adds a start-of-draft grace period to the very
-- first pick's deadline, and makes leaving an empty waiting room
-- delete it outright. Run ONCE in the Supabase SQL editor against a
-- database that already has the Mock Drafts tables/RPCs live (see the
-- note above the Mock Drafts section in schema.sql for why this can't
-- just be folded into a CREATE TABLE there).
-- ============================================================

-- Same signature as the live version -- CREATE OR REPLACE is safe
-- here. Only change: pick 1's deadline gets a flat extra 30 seconds
-- on top of the normal per-pick timer, so people have time to land on
-- the live draft view before the clock starts feeling urgent. No new
-- status value -- the client just shows a "Draft starting -- get
-- ready" label while time remaining is still above pick_seconds.
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
         pick_deadline = now() + interval '30 seconds' +
           (case when first_slot.is_bot then interval '4 seconds' else make_interval(secs => room.pick_seconds) end)
   where id = p_room_id;
end;
$$;

grant execute on function public.start_mock_draft(uuid) to authenticated;

-- Same signature as the live version. Unchanged for the "you're
-- mid-draft" case (still only acts where status = 'waiting', i.e. it
-- stays a genuine no-op once a draft is live -- leaving mid-draft is a
-- pure client-side action, no RPC call). New behavior only for the
-- waiting-room path: after clearing the caller's slot, if the room
-- now has zero human-occupied slots left, delete the room outright.
-- Slots/picks cascade-delete via the existing FK.
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

  delete from public.mock_draft_rooms
  where id = p_room_id and status = 'waiting'
    and not exists (select 1 from public.mock_draft_slots where room_id = p_room_id and user_id is not null);
end;
$$;

grant execute on function public.leave_mock_draft_room(uuid) to authenticated;
