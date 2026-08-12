# The Board — CLAUDE.md

Context for an agent picking up this repo cold. Read this before making
changes; it explains the shape of the codebase, what's real vs. stubbed,
and where to look for things.

## What this is

"The Board" is a fantasy-football companion site: rankings, a trade
analyzer, per-league standings (Sleeper/ESPN), paid expert reviews,
subscriptions, and a Posts/blog section. It's Kyle (and Wesley's) site,
hosted on GitHub Pages, backed by a single live Supabase project.

## Stack, and the one rule that shapes everything else

**No build step. No framework. No npm dependencies except the Supabase
CLI (devDependency, for `supabase/` tooling only).** Every page is a
plain `.html` file that loads `css/theme.css`, a fixed stack of
`<script src="js/*.js">` tags (Supabase JS + a couple of small CDN
libraries, then this repo's own files), and its own inline
`<script>...</script>` wrapped in an IIFE at the bottom. There's no
bundler, no transpilation, no JSX — what you write is what ships to
GitHub Pages, verbatim.

Consequences that matter when editing:
- Shared behavior lives in `js/*.js` files that attach a single global
  (`window.Auth`, `window.sb`, `window.PlayerRender`, ...) and every
  page's inline script reads from those globals. There's no module
  system, so **script tag order matters** — copy the order from a
  page that already uses what you need (see "Shared JS modules" below).
- Every page duplicates its own `<style>` block for page-specific CSS;
  only truly cross-page styles (modals, the sidebar, the auth box,
  the player picker/detail modal, tier pill colors) live in
  `css/theme.css`. When changing something page-specific, check
  whether it's actually shared before editing the shared file.
- `js/config.js` holds a **real, live** Supabase URL + anon key (see
  SETUP.md for why the anon key is safe to ship — RLS is the actual
  security boundary, not key secrecy). There is no separate
  dev/staging project. Writes made while testing UI locally hit real
  data. Be deliberate about running mutating flows (posting, changing
  roles, submitting expert reviews) against it.
- To preview changes locally: this is static, so `python -m http.server`
  (or any static file server) from the repo root and open the page —
  no install/build required.

## Directory map

```
index.html                 Rankings board ("Redraft Rankings") — the home page.
rankings-editor.html        Create/Edit Rankings — drag-to-reorder personal ranking editor.
my-teams.html                Link Sleeper/ESPN leagues, view standings + rosters.
trade-analyzer.html          FantasyCalc-powered trade value comparison + public recent-trades feed.
expert-reviews.html          Paid review request forms (Team Review / Trade / Start-Sit / Coach) + the expert/admin incoming queue.
expert-reviews-log.html      Full history of expert review requests + responses (admin/expert only).
posts.html                   Blog/analysis posts: published grid, draft workflow, Markdown editor (see below).
notifications.html           Full notifications inbox (see below).
subscriptions.html           Plan picker (Rookie/Pro Bowl/MVP/Hall of Fame — see "Subscriptions" below).
profile.html                 Edit your own profile (avatar URL, username, display name, favorite team).
admin.html                   Admin-only: user list + role assignment, role→permission policy matrix.

css/theme.css                 Every shared style: CSS custom properties (colors/fonts), app shell,
                               modal system, auth box + notification bell, player picker, player detail
                               modal, tier-color pills. Page-specific CSS stays inline in each page instead.

js/config.js                  Live Supabase URL/anon key + edge function URLs + Turnstile site key.
js/supabase-client.js         One-liner: creates window.sb from config.
js/auth.js                    Shared auth chrome (login/signup modal, top-right account box, notification
                               bell dropdown). Exposes window.Auth — see below.
js/sidebar.js                 Renders the left nav from a hardcoded LINKS array; adds Admin/Review Log
                               links when the signed-in user has the relevant permission.
js/players-data.js            Static generated player dataset (window.__PLAYERS__) + window.playerKey().
                               Not hand-edited — see "Player data" below for where it comes from.
js/player-render.js           Shared player-row rendering: tiering, ESPN headshot/team-logo resolution
                               (lazy, via IntersectionObserver), number formatting. Used by index.html,
                               rankings-editor.html, player-picker, post player cards.
js/player-picker.js           Reusable multi-select player search widget (search box + chips). Used by
                               Expert Reviews' forms and the Trade Analyzer.
js/player-detail.js           Shared "player detail" modal: photo, weekly PPR points table (live ESPN
                               gamelog fetch), simplified matchup difficulty, editable notes.
js/fantasy-platforms.js       Sleeper (direct fetch, CORS-open) + ESPN (via espn-proxy edge function)
                               league fetchers for my-teams.html, normalized to one shape.
js/post-render.js             Markdown + embed rendering shared by the Posts editor's live preview and
                               the published post detail view (see "Posts" below).

supabase/schema.sql            Single source of truth for the DB: every table, RLS policy, trigger, and
                                RPC. Read this file's comments first when touching data — nearly every
                                table has a block comment explaining *why* it's shaped the way it is.
supabase/functions/login/      Edge Function: real password sign-in path (IP lockout, username-or-email
                                lookup, tells "no account" apart from "wrong password" — GoTrue's own
                                signInWithPassword can't do either).
supabase/functions/espn-proxy/ Edge Function: proxies ESPN's fantasy API so private-league cookies
                                (espn_s2/SWID) can be sent — browsers won't let JS set a Cookie header.
supabase/seed_kyle_wesley.sql  One-time seed script for migrating Kyle/Wesley's existing rankings + roles.

SETUP.md                       Step-by-step first-time backend setup (Supabase project, edge functions,
                                Google OAuth, Turnstile, bootstrapping the first Admin). Start here for
                                "how do I stand this up from scratch."
```

## Shared JS modules — what they expose

- **`window.sb`** (`js/supabase-client.js`) — the Supabase JS client.
  Nearly every page talks to Postgres directly via `window.sb.from(...)`
  / `.rpc(...)`, relying entirely on RLS policies in `schema.sql` for
  authorization. There is no backend API layer beyond the two edge
  functions.
- **`window.Auth`** (`js/auth.js`) — `{ ready (Promise), user, profile,
  can(permissionKey), openLogin(), openSignup(), refreshProfile(),
  markNotificationRead(id), logout(), notifications }`. Fires a
  `window` `'auth:change'` CustomEvent on every sign-in/out/profile
  change; pages listen for this instead of polling. Injects its own
  login/signup modal markup into `<body>` and renders into every
  `<div id="authBox">`.
- **`window.PlayerRender`** (`js/player-render.js`) — tiering (S–H),
  number formatting, ESPN headshot resolution, `buildAvatarWrap(player,
  observer)` (the standard way to render a player photo anywhere).
- **`window.PlayerDetail`** (`js/player-detail.js`) — `.open(player)`
  opens the shared player detail modal from anywhere it's loaded.
- **`window.PostRender`** (`js/post-render.js`) — `.render(markdown)`
  → sanitized HTML, `.hydrate(container)` wires up player-card
  avatars/click-through inside already-rendered HTML. See "Posts" below.
- **`window.__PLAYERS__` / `window.playerKey(p)`**
  (`js/players-data.js`) — the player dataset and its canonical key
  (`lower(name)|upper(team)`), used everywhere a player needs to be
  identified consistently (rankings, notes, post player cards).

## Data model (high level — `supabase/schema.sql` is authoritative)

- `profiles` — one row per `auth.users` row. `role` (user/editor/admin)
  and `subscription_tier` (free/premium/elite/legendary — **DB values
  unchanged**, see "Subscriptions" below) are both writable only
  through triggers/RPCs, never a plain client-side UPDATE.
- `permissions` / `role_permissions` — the whole authorization system.
  Every gated action checks `has_permission(uid, 'key')`, which joins
  through the caller's role. Edited via `admin.html`'s policy matrix.
  Notable keys: `create_posts`, `publish_posts`, `delete_posts`,
  `manage_expert_reviews`, `create_edit_own_rankings`,
  `publish_official_rankings`, `manage_users`, `manage_role_policies`,
  `edit_player_notes`, `log_analyzed_trades`.
- `rankings` — one row per (owner, player); an editor/admin's saved
  ranking is what appears as a public "Ranker" option on the board.
- `notifications` — short messages surfaced in the bell dropdown and
  now `notifications.html` (see below). Written only by security-definer
  RPCs (e.g. `admin_respond_expert_review`); users can only read their
  own and flip `read`.
- `subscription_tier_limits` / `subscription_perks` — the numbers
  behind each plan (league limit, free review credits/period). Data,
  not hardcoded logic, so a pricing/perk change is a SQL edit.
- `expert_review_requests` — paid review requests + expert responses.
- `fantasy_teams` — linked Sleeper/ESPN leagues (`platform` check
  constraint currently only allows `'sleeper'`/`'espn'` — no Yahoo row
  shape exists yet, see "Not yet implemented").
- `analyzed_trades` — public log of trades run through the Trade
  Analyzer, auto-logged.
- `posts` — Posts page rows. `body` is Markdown text (rendered client
  side by `js/post-render.js`, not stored as HTML). `status`
  (draft/published) can only be flipped by `publish_posts` permission,
  enforced by a trigger, not just RLS.
- `player_notes` — free-text note per player, shown in the player
  detail modal, editable by `edit_player_notes`.
- `login_attempts` — backs the login edge function's IP lockout; no
  RLS policies at all on purpose (only the service-role edge function
  touches it).

## Design choices worth knowing before you change them

- **Visual language**: dark leather/brass "draft board" theme — see
  the CSS custom properties at the top of `css/theme.css`
  (`--bg`, `--panel`, `--brass`, `--tier-*`, ...). Headings use
  Fraunces (serif), UI chrome/labels use JetBrains Mono, body text
  uses Inter. Reuse these variables and fonts rather than introducing
  new ones.
- **RLS is the real authorization boundary**, not client-side checks.
  `window.Auth.can(...)` gates *UI visibility* for a better UX, but
  every actual write is re-checked by a Postgres policy or a
  `security definer` RPC in `schema.sql`. When adding a new
  privileged action, follow that existing pattern (RPC does the
  permission check itself) rather than trusting the client.
- **No file storage yet** — avatar URLs, post thumbnails, and post
  body images are all just pasted URLs (hosted elsewhere, e.g. Imgur/
  Google). There's no Supabase Storage bucket or upload flow anywhere
  in the app. If "upload an image" is ever requested, that's new
  infrastructure, not a small tweak.
- **Everything-is-a-modal** pattern (`.modal-backdrop` / `.modal-box`
  in `theme.css`) for auth, player detail, post detail/editor, etc. —
  follow it for new dialogs rather than inventing a new overlay system.
- **IIFEs, not modules** — every inline `<script>` and every `js/*.js`
  file is `(function(){ ... })();` writing to one `window.X` global.
  Keep new shared code in that shape so script-tag ordering keeps
  working.

## Subscriptions

Display names were reskinned to be sports-themed: **Free → Rookie,
Premium → Pro Bowl, Elite → MVP, Legendary → Hall of Fame** (only the
`name` shown in `subscriptions.html`'s `PLANS` array — the underlying
DB tier slugs `free`/`premium`/`elite`/`legendary` are unchanged
everywhere else, since they're baked into `schema.sql` check
constraints/RLS). If new tier names are wanted again, only that one
array needs to change.

## Posts (Markdown editor + rendering)

The Posts editor (`posts.html`) is a compact-meta-fields + toolbar +
split body/preview layout:
- Title/Category/Thumbnail/Video/Excerpt/Subscriber-only are packed
  into a dense row up top (`.editor-meta-compact`) to leave most of
  the modal for the body.
- The body is Markdown, written in a plain `<textarea>` on the left
  with a live-rendered preview on the right (`window.PostRender`,
  loaded via `unpkg` CDN's `marked` + `DOMPurify` — the only two
  runtime dependencies in the whole app that aren't first-party or
  Supabase's own SDK).
- A toolbar inserts Markdown at the cursor: bold/italic/heading/list/
  quote directly; link/image/YouTube via `window.prompt()` for the
  URL (kept intentionally simple — no custom URL-picker modal); a
  "Player Card" button opens a small popover that searches
  `window.__PLAYERS__` and inserts a `{{player:Full Name}}` token.
- **Custom syntax `js/post-render.js` understands, beyond stock
  Markdown**: a bare YouTube URL alone on its own line becomes an
  inline embedded player; `{{player:Full Name}}` becomes a compact,
  clickable player card (photo + team/pos/PPG, opens
  `window.PlayerDetail`). Everything else is plain GFM Markdown
  (bold/italic/headings/links/images/lists/blockquotes/code) via
  `marked`, then sanitized with `DOMPurify`.
- The exact same `PostRender.render()` + `.hydrate()` pair renders
  the published post detail view, so editor preview and the live post
  can't drift apart.
- Post authorship is already gated by RLS (`create_posts`), so
  `DOMPurify` here is defense-in-depth against a stray pasted
  `<script>`, not a hard trust boundary against arbitrary users.

## Notifications

`notifications.html` is the full inbox (all/unread tabs, mark one or
all read, paginated via `.range()`), reachable from: the bell
dropdown's "View all notifications" footer link, a "Notifications"
entry in the account dropdown menu, and a link on `profile.html`.
The bell dropdown itself (`js/auth.js`) still shows a short recent
list for quick access. Both read from the same `notifications` table;
`window.Auth.refreshProfile()` is called after any mark-read so the
bell's unread dot stays in sync across pages.

## Not yet implemented (stubbed)

Search the repo for `STUB` to find every marked spot — as of this
writing:

- **Stripe billing.** Nothing charges real money anywhere.
  `subscriptions.html`'s "Choose This Plan" calls
  `set_my_subscription_tier()` and flips the tier *immediately* — a
  real integration replaces that with a Stripe Checkout Session,
  applied from a webhook once payment succeeds (see the comment
  inside that RPC in `schema.sql`). Same story for Expert Reviews:
  `submit_expert_review()` inserts the request as already
  `'submitted'` with no payment step; a real flow would create a
  Checkout Session and only mark it `'submitted'` after a webhook
  confirms the charge (see that RPC's comment, and the matching one
  in `expert-reviews.html`'s purchase flow).
- **Yahoo fantasy platform.** `my-teams.html` shows a disabled "Yahoo
  — Coming soon" tab. Needs a registered Yahoo OAuth app (there isn't
  one) before any code can be written — `fantasy_teams.platform`'s
  check constraint doesn't even allow `'yahoo'` yet.
- **No file/image upload.** See "No file storage yet" above — every
  image anywhere in the app (avatars, post thumbnails, post body
  images) is a pasted external URL.

## Known simplifications (intentional, documented in code — not bugs)

- Player detail matchup difficulty is ranked by *overall* points
  allowed per game, not position-specific defense strength, because
  there's no verified free source for the latter (see the comment
  above `loadDefenseRanks()` in `js/player-detail.js`).
- ESPN team/position/lineup-slot ID maps in `js/fantasy-platforms.js`
  are community-reverse-engineered (ESPN's fantasy API is
  unofficial/undocumented) — if a team or position ever renders
  wrong, that table is the first place to check.
- `js/players-data.js` is a generated static dataset, not hand-authored
  — treat `window.__PLAYERS__` as data to consume, not to hand-edit
  piecemeal.
