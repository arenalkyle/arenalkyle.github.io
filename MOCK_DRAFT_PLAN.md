# Mock Draft Overhaul — Plan

## Progress

- [x] **Part 1 — Database & reliability foundations** — built, not
  browser-verified.
- [x] **Part 2 — Page split (full-screen live-draft tab)** — built, not
  browser-verified. See Verification section — nothing in this plan has
  actually been clicked through against live Supabase yet.
- [x] **Part 3 — In-draft UX polish** — built, not browser-verified.
- [x] **Part 4 — Results modal, scrollbar theming, docs** — built, not
  browser-verified.

## Context

The Mock Draft feature (`mock-draft.html` lobby, `mock-draft-room.html` waiting
room + live draft + results, `supabase/schema.sql`'s Mock Drafts section) has
accumulated a long list of real bugs and UX gaps now that people are actually
using it: autopick silently stops working, rooms get stuck showing "Stalled"
forever, rematch rooms get double-named, the draft board resizes as picks
come in, roster panels show a player's position twice, there's no sound/queue
discipline, and the whole live-draft experience is squeezed into the normal
sidebar'd page layout instead of taking over the screen the way a real draft
board would.

This plan covers a full pass over all of it. It's split into 4 parts so it's
reviewable/executable as coherent chunks: **(1) database + reliability
foundations, (2) the page split into a dedicated full-screen live-draft tab,
(3) in-draft UX polish, (4) the results modal + global scrollbar theming +
docs.** Below, every non-obvious decision is called out with *why*, since
several of the original asks conflicted with each other or with the site's
"no build step / no server cron / everything client-driven" architecture
(see `CLAUDE.md`'s Mock Drafts section), and had to be reconciled.

Answers already locked in from clarifying questions:
- The live draft opens in a **literal new browser tab** (not a same-tab
  redirect) — but only from an explicit click (see Part 2's popup-blocker
  note — this is a technical necessity, not a preference change).
- **No new "force-complete a stale room" mechanism.** A slot that misses its
  deadline already flips to `autopick = true` (existing behavior) and drafts
  itself from then on; the draft simply keeps autopicking forward until it
  naturally reaches its last pick and completes, exactly like today, just
  reliably (Part 1 fixes the actual bug that made this flaky). No "Stalled"
  label, no "End Draft" button.
- **"Leave Draft" during a live draft is a pure client-side action** (close
  the tab) — it does **not** touch the database, convert the slot to a bot,
  or kick anyone out. The user was explicit: if someone's browser closes or
  they click away, their slot should sit exactly as it was so they can come
  back later, reopen the room, and flip their own Autopick toggle off to
  resume drafting themselves. This is why the missed-deadline-autopick
  mechanism from Part 1 matters — it's the actual mechanism carrying an
  absent human's team forward, not a new "leave" RPC.
- **"View Results" is a modal**, not a page — consistent with the site's
  existing "everything is a modal" convention (`CLAUDE.md`), not a new
  pattern.

---

## Part 1 — Database & reliability foundations — ✅ DONE

No new page yet. This is the ground everything else stands on: fix the
things that are actually broken today, and land the one real schema change
(a start-of-draft grace period + delete-empty-waiting-rooms), before touching
any UI layout.

### 1a. Fix the actual autopick bug — ✅ done

**Root cause found in `mock-draft-room.html`'s `tickClock()`:**

```js
if (due && autopickInFlightForPick !== room.current_pick){
  autopickInFlightForPick = room.current_pick;   // <-- set BEFORE we know a pick will happen
  ...
  var candidate = ...;                            // can end up null
  if (candidate){
    window.sb.rpc('mock_draft_make_pick', ...)
  }
  // if candidate was null, nothing was ever sent to the server,
  // but autopickInFlightForPick is now permanently "handled" for
  // this pick number on this browser tab — it will never retry.
}
```

`bestAvailableForSlot()` can legitimately return `null` (e.g. the remaining
player pool has nobody left who fits an open roster slot under the strict
`canDraftPosition()` rule). When that happens today, the guard flag is
already poisoned and that browser will never attempt this pick again — if
it's the only connected browser, the draft hangs forever with the clock
frozen at `0s`. This is the actual "autopick doesn't work" bug, and it's
also most of what today's "Stalled" state is a band-aid for.

**Fix (in `mock-draft-room.html`, and identically in the new
`mock-draft-live.html` from Part 2 since it inherits this logic):**
- Only set `autopickInFlightForPick` once a candidate is actually found and
  the RPC call is being made — not just because `due` was true.
- Add a guaranteed last-resort fallback: if no candidate satisfies
  `canDraftPosition()` (roster-aware pick), fall back to the single
  best-ranked undrafted player in the whole pool, ignoring roster
  construction. A pick always gets made — the draft can never stall on "no
  legal candidate," only ever on "literally zero people have this room
  open," which Part 1c's delete-when-empty + the natural human behavior of
  someone eventually reopening the link both handle.
- This already fires for **any** on-the-clock slot from **any** connected
  browser (bots, autopick-flagged humans, or a plain expired deadline) — the
  "anyone on the board, not just my queue" behavior the original request
  asked for already exists structurally in `tickClock()`; it just needed
  this bug fixed to actually be reliable.

### 1b. Bot "personality" — stop drafting in exact rank order — ✅ done

Today bots always take the literal #1 ranked eligible player
(`bestAvailableForSlot` returns the single best fit). Real drafters don't.
Change: instead of always taking index `0` of the eligible, rank-sorted
candidate list, weight a random pick among the top of that list — e.g. pick
uniformly among the top 3 eligible candidates, weighted 60/25/15 toward
1st/2nd/3rd. Implemented as a small helper next to `bestAvailableForSlot()`
in the tick logic; `Math.random()` is fine here (this is plain page JS, not
a Workflow script). Applies to both true bots and autopicked humans, since
both go through the same fallback path.

### 1c. Migration: `supabase/migrate_mock_draft_leave_and_start_buffer.sql` — ✅ done

New one-time migration (same pattern as the two existing
`migrate_mock_draft_*.sql` files), plus matching updates to the `CREATE OR
REPLACE` bodies already in `schema.sql` (source of truth for a fresh
install) and the block-comment list of migrations at the top of the Mock
Drafts section.

- **`start_mock_draft()`**: add a flat 30-second grace period to the very
  first pick's deadline only, so people have time to land on the new live
  tab before the clock starts feeling urgent:
  ```sql
  pick_deadline = now() + interval '30 seconds' +
    (case when first_slot.is_bot then interval '4 seconds'
          else make_interval(secs => room.pick_seconds) end)
  ```
  No new `status` value needed — pick 1 just has a longer timer. The live
  page (Part 2) shows a "Draft starting — get ready" label instead of "on
  the clock" while the remaining time is still above `pick_seconds`.
- **`leave_mock_draft_room()`**: unchanged for the "you're mid-draft"
  case (still only acts `where ... status = 'waiting'`, i.e. it stays a
  genuine no-op once a draft is live, matching the "act as if they're still
  there" decision above). New behavior only for the waiting-room path: after
  clearing the caller's slot, if the room now has zero human-occupied slots
  left (`not exists (select 1 from mock_draft_slots where room_id = ... and
  user_id is not null)`), delete the room outright
  (`delete from public.mock_draft_rooms where id = p_room_id`). Slots/picks
  cascade-delete already (existing FK `on delete cascade`). This is scoped
  to the pre-draft lobby only — exactly what "if I leave a room and no one
  else is in there, delete that room" describes; it does not apply mid-draft
  since leaving mid-draft is a client-only action now.
- `end_mock_draft_room()` RPC is left in place in the database (harmless,
  no migration needed to remove it) but its **button is deleted from the
  UI** in Part 2 — nothing calls it anymore.

### 1d. Kill the "Stalled" state and fix rematch double-naming — ✅ done

Also pulled the CLAUDE.md doc-sync forward for just this part (rather than
waiting for Part 4's full rewrite), since leaving the Mock Drafts section
describing a "Stalled" pill that no longer exists would be actively wrong
the moment this landed — CLAUDE.md's Mock Drafts section, the migration
list comment, and the matching `schema.sql` comments were all updated in
the same change. The rest of Part 4's doc rewrite (three-file architecture,
End Draft button removal, etc.) still waits for Part 2.

Both in `mock-draft.html`:
- Delete `isStalled()` / `STALL_THRESHOLD_MS` / the `.stalled` pill variant
  entirely. `fmtStatus()` just returns `'Live'` for any `in_progress` room.
  This is safe now that 1a means a room with anyone's tab open keeps
  advancing, and rooms with literally nobody connected simply sit as "Live"
  until someone reopens them — same as any other client-driven feature on
  this site (there's no server cron anywhere in this codebase; this isn't a
  regression, it's consistent with how autopick has always had to work per
  `CLAUDE.md`'s Mock Drafts note).
- Fix the "(rematch) (rematch)" bug: before appending `' (rematch)'` to the
  new room's name, strip any existing trailing `(rematch)` suffix
  (case-insensitive, repeat-safe) from the source room's name first, e.g.
  `name.replace(/\s*\(rematch\)\s*$/i, '')`. (This logic moves into
  `mock-draft-live.html` in Part 2 since that's where "Draft Again" now
  lives, alongside the results modal's own "Draft Again" per Part 4 — same
  one-line fix applied in both places.)

---

## Part 2 — Page split: a dedicated full-screen live-draft tab — ✅ DONE

Implementation note (superseded by Part 4): this part originally landed
with an interim measure, since Part 4's results modal didn't exist yet —
`mock-draft.html`'s "View Results" button and `mock-draft-room.html`'s
stray-visit-to-a-completed-room redirect both pointed at
`mock-draft-live.html`, which renders the completed state (board + team
panel + Draft Again) whenever it's opened for an already-completed room.
Part 4 replaced both of those call sites with the real in-page modal in
`mock-draft.html` per the design below. `mock-draft-live.html` still
renders the completed state in place for whoever already has that tab
open when a draft finishes (or visits the URL directly) — see the
"Results modal" section of Part 4.

### The split

Three files end up with three distinct jobs:

- **`mock-draft.html`** (lobby) — unchanged create/join/browse, plus Part
  4's results modal, plus updated room-card routing (below).
- **`mock-draft-room.html`** (waiting room) — trimmed down to **only** the
  pre-draft experience: slots grid, claim/leave a seat, invite link, Start
  Draft. All of today's live-draft and completed-draft rendering code is
  deleted from this file — that logic moves to the new page below.
- **`mock-draft-live.html`** (new) — the full-screen, no-sidebar, no-topbar
  drafting experience. This is the "brand new tab/page" from the request.
  It handles both the `in_progress` view (drafting) and — since the tab
  stays open and dedicated — also renders the `completed` state in place
  once the draft it's watching finishes (board + team panel + "Draft
  Again"), so the tab doesn't just go dead the moment the last pick is
  made.

### Why a real new tab, opened only from an explicit click

`window.open()` calls that aren't the direct, synchronous result of a user
click are blocked by every major browser's popup blocker. A realtime
`postgres_changes` callback firing when the *host* starts the draft is not
a click — it's an async network event — so silently auto-popping a tab open
for every other participant the instant the host hits Start Draft would get
blocked for most of them.

Fix: `mock-draft-room.html`, on detecting via its existing realtime
subscription that `status` flipped to `in_progress`, does **not** call
`window.open()` itself. Instead it swaps its content for a prominent "The
draft has started!" panel with an **Enter Draft →** button. Clicking that
button is a direct user gesture, so `window.open('mock-draft-live.html?room='
+ id)` from inside that click handler is reliable. This also just reads
better than a tab silently spawning behind the user's back.

Room-card routing in `mock-draft.html`'s `roomCard()` also changes:
- `waiting` → navigate to `mock-draft-room.html?room=ID` (unchanged).
- `in_progress` → `window.open('mock-draft-live.html?room=' + id)` directly
  from the button's click handler (skips the waiting room entirely, since
  they're already past it) — reliable for the same reason above.
- `completed` → open the Part 4 results modal in place, no navigation.

A stray direct/bookmarked visit to `mock-draft-room.html?room=ID` for a room
that's no longer `waiting` is handled gracefully: if `in_progress`, show the
same "Enter Draft →" panel (still an explicit click, still reliable); if
`completed`, `window.location.href` to `mock-draft.html?results=ID`, and
`mock-draft.html` opens the results modal automatically on load when that
query param is present. This means the results-modal rendering code lives
in exactly one place (`mock-draft.html`) even though three different entry
points can reach it.

### Full-screen layout (`mock-draft-live.html`)

No `.app-shell` / `.sidebar` / `.topbar` at all — this page intentionally
doesn't load `js/sidebar.js` and doesn't render an `#authBox`/topbar, per
"our current header is not necessary with showing the profile." Structure:

```
.live-shell (full viewport)
  .live-header  — back-arrow (top-left) · room name/status · Sound toggle · Leave Draft
  .live-3col    — CSS grid, fills the rest of the viewport height
      .pool-col   (~300px, always-visible, internally scrollable)  — the player pool
      .board-col  (1fr, center)                                     — the draft board
      .team-col   (~320px, internally scrollable)                   — team dropdown + roster + queue
```

The existing Board/Players **tabs are removed** — both are simultaneously
visible as their own columns now, which is what "player list scrollable on
the left, board always in the center, my team on the right" asked for.

**Back arrow / Leave Draft** are two entry points to the same handler:
`window.close()`, falling back to `window.location.href = 'mock-draft.html'`
if `window.close()` doesn't actually close anything (e.g. the tab wasn't
opened by a script — someone typed the URL directly, or `window.opener` is
null). Per the earlier decision, this performs **no server call** — it's
purely "stop looking at this tab."

### Board sizing — actually fixed this time

Current `.board-wrap{ max-height: 60vh }` + `table-layout:fixed` already
locks *column* widths, but row *height* is still auto — a cell that goes
from empty to holding a name-plus-position-plus-bye (Part 3) grows, and that
growth is the actual resize people are seeing. Fix: give `td.board-cell` an
explicit fixed `height` (not `min-height`) sized to comfortably fit all
three lines (pick label / name / pos+bye) with `overflow:hidden`, so
**every** cell — empty, on-the-clock, or filled — is pixel-identical from
the very first render. Nothing changes shape as picks stream in.

Screen-size responsiveness (the "shrink or increase the overall size
depending on the screen" ask) still comes from `.board-wrap`'s height being
viewport-relative (`calc(100vh - <header height>)` inside the new
full-screen shell) and column widths being `fr`-based in the 3-col grid —
that's the layout responding to screen size; the per-cell fixed height is
what stops it from responding to *data changes*, which are two different
axes and both were being conflated in the original bug.

---

## Part 3 — In-draft UX polish

All of this lives in `mock-draft-live.html` (and the small "my roster"
render helper duplicated into `mock-draft.html`'s results modal, per Part
4 — this codebase doesn't have a shared component system, so the existing
convention — see `CLAUDE.md` — is small, page-local duplication rather than
inventing a new shared `js/*.js` module for a couple hundred lines used in
two places).

- **Sound.** A short synthesized two-tone chime via the Web Audio API
  (`OscillatorNode`) plays the instant it becomes the local viewer's turn —
  no external audio asset needed (this site has no file storage/CDN asset
  pipeline to hang a `.mp3` off of, per `CLAUDE.md`'s "No file storage yet").
  A **Sound** toggle button in `.live-header` flips a `localStorage` flag
  (`ff_mock_draft_sound_v1`) that gates it; defaults to on.
- **Draft-button turn-transition buffer.** Track the last-seen on-the-clock
  slot; the instant it changes to the local viewer, start a 2-second
  window during which every "Draft" button (pool list + queue panel)
  renders visibly disabled/greyed, then re-render once the window elapses.
  Prevents "I meant to hit Queue on the player who was up, not Draft on
  whoever's on the clock now."
- **Queue vs. Draft visibility.** In the player pool: if it's **not** the
  viewer's turn, show only the **Queue** button (no Draft button at all —
  not just disabled). If it **is** their turn, show only **Draft** (subject
  to the buffer above) — no Queue button while it's already their turn to
  act.
- **Team-switch dropdown.** A `<select>` at the top of the right column's
  team panel, options = all slots ordered by `slot_index` (draft position),
  each labeled with its `team_label`, the viewer's own slot prefixed (e.g.
  "★ You — ..."). Selecting a team re-renders the same roster panel for that
  team (reusing `rosterAssignmentHtml()`); defaults to the viewer's own team
  (or slot 1 if only spectating). The select gets a distinct border/tint
  style while showing the viewer's own team vs. someone else's, since a
  native `<select>` can't style individual options consistently
  cross-browser. The board's existing "click a column header to view that
  team" modal stays as a secondary shortcut to the same panel.
- **Bye week + position everywhere a player appears**, fixing the "name
  their position and their bye week" ask + the "position shown twice" bug
  in one pass:
  - **Board cells**: add a compact `POS · Bye N` line under the player name
    (tiny, matches the cell's existing position-tinted background).
  - **Recent picks ticker**: same `POS · Bye N` line added to each entry,
    addressing "it's not too informative" — it already showed the last 12
    picks, not just 1 (that's the separate small "Last Pick" card in the
    clock bar, which stays as-is for the at-a-glance case), but each entry
    only had a name; now it also carries position + bye.
  - **Roster panels (My Team, team-switch dropdown target, results modal)**:
    `rosterSlotHtml()` changes so a starter slot whose type *matches* the
    drafted player's actual position (e.g. a "QB" slot holding a QB) colors
    the **slot-type badge itself** with that position's color and drops the
    separate colored pill entirely — no more "QB (name) QB". A slot whose
    type differs from the player's actual position (FLEX, BENCH) keeps
    showing both, since there they carry different information, plus a
    small bye-week tag next to the name.
  - **Bench section shown at full capacity immediately**: instead of only
    listing actual bench picks (with a "No bench picks yet" placeholder),
    render `roster_bench` rows up front (filled ones showing the pick,
    empty ones showing "Empty" — mirroring exactly how starter slots
    already render), so the bench is visibly there and sized correctly from
    the start of the draft rather than only appearing once something lands
    on it.

---

## Part 4 — Results modal, global scrollbar theming, docs — ✅ DONE

### Results modal

New modal in `mock-draft.html` (`.modal-backdrop`/`.modal-box`, matching
every other dialog on the site per `CLAUDE.md`'s "everything is a modal"
convention) — replaces today's `mock-draft-room.html`'s completed view for
all lobby-driven access. Content: the same fixed-size board table + the
same team-switch dropdown + roster panel from Part 3 (viewer's own team by
default, switchable to anyone), plus a **Draft Again** button (same
double-"(rematch)" fix from Part 1d applied here too, since this is now
also an entry point that creates rematch rooms). Opens either from a
completed room's "View Results" button, or automatically on page load when
`?results=<room_id>` is present (the redirect target from a stale
`mock-draft-room.html` visit — see Part 2).

Requires adding `js/players-data.js`, `js/player-render.js`, and
`js/player-detail.js` script tags to `mock-draft.html` (it doesn't load
them today), same order as `mock-draft-room.html` uses them.

### Global scrollbar theming

Today every scrollable panel (sidebar, board, player pool, notif dropdown,
player-picker results, etc.) shows the browser's default grey/white
scrollbar, which clashes with the dark leather/brass theme. Fix once,
globally, in `css/theme.css` rather than per-component:

```css
html{ scrollbar-width: thin; scrollbar-color: var(--brass-dim) var(--panel); }
*::-webkit-scrollbar{ width: 10px; height: 10px; }
*::-webkit-scrollbar-track{ background: var(--panel); }
*::-webkit-scrollbar-thumb{ background: var(--brass-dim); border-radius: 999px; border: 2px solid var(--panel); }
*::-webkit-scrollbar-thumb:hover{ background: var(--brass); }
```

Applies automatically to every current and future `overflow:auto` /
`overflow-y:auto` container site-wide (sidebar, board-wrap, pool-table-wrap,
the new live page's 3 columns, notif-panel, player-picker-results,
pd-notes-history, etc.) with a single addition — no per-page edits needed.

### CLAUDE.md doc-sync instruction (also applied to this change)

Add a short new section near the top of `CLAUDE.md` (something like "Keep
docs in sync") instructing future agents: whenever a change alters
something a markdown doc describes (`CLAUDE.md`, `SETUP.md`, `ROADMAP.md`,
`README.md`), update that doc in the same change — don't leave it
describing stale behavior. Then, as the last step of implementing this
plan, actually apply that: rewrite `CLAUDE.md`'s "Mock Drafts" section to
describe the new three-file architecture, the fixed autopick/leave
semantics, the removed Stalled state and End Draft button, and the new
migration file — so the doc matches the code the moment this plan lands,
not after some future drive-by edit.

---

## Files touched (summary)

- `supabase/migrate_mock_draft_leave_and_start_buffer.sql` (new) — ✅ done
  (Part 1c)
- `supabase/schema.sql` — matching `CREATE OR REPLACE` updates + migration
  list comment — ✅ done (Part 1c)
- `mock-draft.html` — ✅ Stalled removal done (Part 1d); ✅ room-card
  routing done (Part 2, superseded by Part 4's real modal); ✅ results
  modal + new script tags (`players-data`/`player-render`/`player-detail`)
  + `?results=` auto-open done (Part 4)
- `mock-draft-room.html` — ✅ autopick-stall fix, bot weighting, rematch
  double-naming fix done (Part 1a/1b/1d); ✅ trimmed to waiting-room-only
  + "Enter Draft" handoff + completed-room redirect done (Part 2);
  ✅ completed-room redirect repointed at `mock-draft.html?results=`
  (Part 4)
- `mock-draft-live.html` (new) — ✅ full-screen live draft + in-place
  completed view done (Part 2); ✅ sound/turn-buffer/queue-visibility/
  team-switch-dropdown/bye+pos-everywhere done (Part 3)
- `css/theme.css` — ✅ global scrollbar rules done (Part 4)
- `CLAUDE.md` — ✅ Mock Drafts section fully rewritten for the landed
  three-file architecture + results modal, doc-sync policy section
  added (Part 4)

## Verification

This checklist covers the whole plan. As of Part 4 landing, all four
parts are buildable and should be runnable end to end. **None of it has
actually been exercised in a browser yet** — every part was verified only
by static checks (schema review, bracket/reference balancing on the JS,
a best-effort syntax check on the extracted inline script — no Node
available in this environment, so Part 4's check was a Python bracket-
balance pass plus manual review), never by clicking through a real
two-tab draft against the live Supabase project. Treat every bullet
below as unverified. The migration in step 1 also still needs to be
confirmed as run — this doc doesn't know whether that's happened since
Part 1 landed.

1. Run the new migration file once in the Supabase SQL editor (per
   `SETUP.md`'s existing pattern for the other `migrate_mock_draft_*.sql`
   files).
2. Serve the site locally (`python -m http.server`) and, using two browser
   profiles/windows signed in as two different accounts:
   - Create a room, confirm the waiting room still works, start the draft,
     confirm "Enter Draft →" appears and opens a real new tab.
   - Let a pick's timer expire without acting — confirm autopick actually
     fires (the Part 1a bug fix) and the draft keeps moving, including near
     the end of a draft where roster slots get tight (stresses the new
     fallback-candidate path).
   - Close one tab mid-draft without clicking anything, reopen the room
     from the lobby later, confirm the slot is untouched and the Autopick
     toggle can be flipped off to resume drafting manually.
   - Finish a draft; confirm the live tab shows results in place, and
     separately confirm the lobby's "View Results" button opens the
     results modal (not the live tab) showing the same board + roster
     content. Also confirm a stray visit to `mock-draft-room.html` for
     that room redirects to `mock-draft.html?results=<id>` and the modal
     auto-opens, and that the team-switch dropdown in both the modal and
     the live tab lets you view any team's roster, defaulting to your own.
   - Create a rematch from both the live tab and the results modal; confirm
     the name never doubles "(rematch) (rematch)".
   - Leave a room with nobody else in it from the waiting room; confirm the
     room disappears from the lobby (deleted).
   - Confirm the chime plays the instant it becomes your turn (and doesn't
     replay on unrelated re-renders), the Sound toggle mutes/unmutes it and
     persists across reload, every Draft button is briefly disabled right
     after your turn starts, the pool shows only Queue when it's not your
     turn and only Draft when it is, and every board cell/ticker entry/
     roster slot shows position + bye week per the Part 3 design (with
     starter slots coloring the badge instead of double-showing position).
3. Resize the browser window during an active draft and confirm the board
   scales with viewport size but individual cells never jump/resize as
   picks land.
4. Visually confirm scrollbars are themed (not default grey) across the
   sidebar, the new live page's columns, and at least one existing modal.
