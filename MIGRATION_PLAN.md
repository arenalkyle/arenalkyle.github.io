# Migrating off GitHub Pages: recommended stack

## Context

The site currently ships as 15 plain `.html` files (~9,858 lines total)
with shared behavior in `js/*.js` files attached to `window` globals,
loaded via a fixed `<script src>` stack whose *order* is the only thing
enforcing dependencies. CLAUDE.md documents this as a deliberate
constraint ("no build step... every page's inline script... IIFEs, not
modules") that made sense for zero-friction GitHub Pages hosting.

That constraint no longer needs to hold once you're paying for a real
web host/VPS instead of GitHub Pages. This doc answers: given that
move, what should the HTML be reformatted into for (1) faster for an
agent to read/edit, (2) faster/better for the site's actual visitors,
(3) less duplicated code, (4) a better-organized repo.

Confirmed with the user: go with a full component framework (not a
lighter templating-only step), and hosting will be a paid web host or
VPS (exact provider undecided).

## Recommendation: Astro, static output, deployed as plain files

**Astro** is the right fit here, not Next.js/SvelteKit/etc., for reasons
specific to this repo:

- An `.astro` component is HTML + scoped `<style>` + a frontmatter
  script block — the smallest possible conceptual jump from what's
  already here, but with real `import`s instead of hoping script-tag
  order is right.
- Astro ships **zero JS by default**; interactivity is opt-in via
  explicit "islands." Today every page unconditionally loads the full
  shared script stack even on pages that barely use it (e.g.
  `admin.html` loading `player-detail.js`, `player-render.js`, etc.
  just for the shared chrome). Islands fix this directly — real,
  measurable payload reduction for visitors.
- File-based routing maps almost 1:1 onto the current page list
  (`rankings.astro`, `my-teams.astro`, `mock-draft/[code].astro`, ...),
  so this is a port, not a from-scratch rewrite.
- The backend doesn't change at all: Supabase + RLS stays exactly as
  documented in CLAUDE.md ("RLS is the real authorization boundary").
  Astro only replaces how HTML/CSS/JS get assembled and shipped.
- Build output is static files. On a VPS/web host, that means `astro
  build` → upload `dist/` → serve with nginx/Caddy. **No Node process
  needs to run in production.** Anything that genuinely needs a server
  (Stripe webhooks per ROADMAP.md, the ESPN cookie proxy) keeps using
  Supabase Edge Functions, exactly like `login`/`espn-proxy` already do
  — that pattern doesn't change, so ROADMAP.md's plans aren't affected.

Next.js was considered and rejected: its value is SSR/API routes, and
this app has neither — everything already talks to Supabase directly
from the client with RLS as the boundary. Next's App Router would add
server/client component boundary complexity for zero benefit here.

## What actually gets smaller / better

- **Duplicated `<style>` blocks** (CLAUDE.md: "every page duplicates
  its own `<style>` block") → scoped component styles; shared tokens
  (`--bg`, `--brass`, `--tier-*`, fonts) stay in one global stylesheet,
  unchanged in spirit from `css/theme.css` today.
- **Duplicated markup/logic between mock-draft pages** — CLAUDE.md
  explicitly flags that `mock-draft.html`'s results modal "duplicates
  the board table and `rosterAssignmentHtml()`/`rosterSlotHtml()`
  roster rendering from `mock-draft-live.html` (page-local, not a
  shared module)." This is the single biggest concrete duplication in
  the repo and becomes one shared `<RosterBoard>`/`<TeamModal>`
  component used by both.
- **Global-script-order dependency** (`window.Auth`, `window.sb`,
  `window.PlayerRender`, `window.PostRender`, `window.PlayerDetail`,
  `window.__PLAYERS__`) → explicit typed imports per component. This is
  the biggest agent-readability win: today, understanding what a page
  depends on means reading its `<script src>` list top to bottom and
  cross-referencing; with imports, it's visible per-file and
  grep-able.
- **Giant single files** (`mock-draft-live.html` 1151 lines,
  `posts.html` 798, `mock-draft.html` 809 mixing markup+style+logic) →
  split into a page + a handful of focused components, each small
  enough to read in one pass.

## Shape of the new repo

- `src/layouts/BaseLayout.astro` — sidebar, auth box, notification
  bell, theme CSS import (replaces the copy-pasted shell every page
  currently has).
- `src/components/` — `Sidebar.astro`, `AuthBox`, `PlayerCard`,
  `PlayerDetailModal`, `RosterBoard`, `TeamModal`, etc. Static ones
  stay `.astro`; interactive ones become islands.
- `src/pages/` — one file per current page, same names
  (`rankings.astro`, `my-teams.astro`, `mock-draft/index.astro`,
  `mock-draft/[roomId]/room.astro`, `mock-draft/[roomId]/live.astro`,
  ...).
- `src/lib/` — today's `js/*.js` globals become typed modules:
  `supabase.ts` (`window.sb` → exported client), `auth.ts`
  (`window.Auth`'s state/methods, likely as a small store since it's
  used everywhere and fires change events), `playerRender.ts`,
  `postRender.ts`, `playersData.ts` (still generated, not hand-edited
  — that doesn't change).
- Islands: pick **one** lightweight UI runtime for interactive pieces
  (Preact is the natural choice — smallest payload, Astro has
  first-class support) for: the mock-draft-live board + queue panel,
  the notifications bell dropdown, the player picker, the
  rankings-editor drag-reorder, the posts Markdown editor
  (toolbar+live preview). Everything else (index, profile, admin
  table, static content pages) stays zero-JS Astro components.
- `js/config.js`'s Supabase URL/anon key move to Astro env vars
  (`import.meta.env.PUBLIC_SUPABASE_URL` etc.), injected at build
  time — same "anon key is safe to ship" rationale from SETUP.md still
  applies, this is just how the value gets into the bundle.

## Migration approach

Port incrementally, in-place against the live Supabase project (RLS
doesn't change, so each ported page can be verified against real data
same as today, no staging environment needed):

1. Scaffold the Astro project, port `BaseLayout` (sidebar + auth box +
   theme tokens) first — everything else depends on it.
2. Port the simplest static pages first (`index.astro`, `profile.astro`)
   to validate the layout and auth flow end-to-end.
3. Port pages with no cross-page duplication next (`admin`,
   `notifications`, `expert-reviews-log`).
4. Port the shared-heavy pages last, extracting `RosterBoard`/
   `TeamModal` as real shared components used by both `mock-draft`
   and `mock-draft-live` — this is where the duplication actually gets
   deleted.
5. Cut over hosting only once every page is ported and verified.

CLAUDE.md needs a full rewrite as part of executing this, not a
section edit — its headline rule ("No build step. No framework.") is
exactly what this migration reverses.

## Verification

- Per ported page: `astro dev`, sign in against the live Supabase
  project, exercise the page's RLS-gated states (signed out / user /
  editor / admin) same as CLAUDE.md's existing pages already require.
- `astro build && astro preview` before each deploy, to test the actual
  static production output, not just dev mode.
- Lighthouse before/after on a representative page (e.g.
  `mock-draft-live`) to confirm the "faster for the user" claim —
  expect a large drop in shipped JS on pages that don't need the full
  current global script stack.
