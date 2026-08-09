# CLAUDE.md

## Kyle/Wesley login workaround (TEMPORARY — remove before real launch)

`js/config.js` still has placeholder Supabase values (`YOUR-PROJECT-REF`,
`YOUR-ANON-PUBLIC-KEY`, etc.) — there is no real Supabase project wired up
yet, so the Supabase-backed login/rankings-save flow in `js/auth.js`,
`rankings-editor.html`, and `admin.html` doesn't actually work on the live
GitHub Pages site.

Until a real Supabase project exists, `js/auth.js` has a hardcoded
client-side login shortcut so Kyle and Wesley can still get past the login
gate and use the rankings editor:

- Username `kyle`, password `wesley` → logs in locally as Kyle (role: admin)
- Username `wesley`, password `kyle` → logs in locally as Wesley (role: editor)

This is **not real authentication**. It's a plain client-side check in
`js/auth.js`, the credential pairs are visible to anyone who reads the
repo (it's public), and it grants permissions (`create_edit_own_rankings`,
`view_admin_panel`) without any server verifying anything. It only exists
so the two of you can use the site before real auth is set up.

### What it touches

- **`js/auth.js`**
  - `LOCAL_LOGIN_OVERRIDES`, `LOCAL_ROLE_PERMS`, `LOCAL_OVERRIDE_KEY`,
    `applyLocalOverride()`, `clearLocalOverride()`, `getStoredOverrideUsername()`
  - The override branch inside `doLogin()`
  - The override branch in the `ready` / session-restore block and in
    `onAuthStateChange` (skips real Supabase session handling while an
    override is stored in `localStorage`)
  - The override branch inside `window.Auth.logout`
- **`rankings-editor.html`**
  - `draftStorageKey()`, `loadLocalDraft()`, `exportRankingsCsv()`
  - The `isLocalOverride` branch in `loadMyRankings()` (loads from
    `localStorage` instead of the `rankings` table)
  - The `isLocalOverride` branch in the Save button handler (exports a CSV
    instead of calling `replace_user_rankings` via Supabase)
- **`supabase/functions/login/index.ts`**
  - `LOGIN_OVERRIDES` and the shortcut-login branch — this is the
    server-side version of the same kyle/wesley shortcut, written before
    it was clear no Supabase project existed yet. It's inert until a real
    Supabase project is deployed. Decide separately whether you want to
    keep this convenience once real auth is live, or remove it then too.

### How the rankings save works right now

Because there's no backend to persist to, clicking **Save Rankings** while
logged in via the kyle/wesley shortcut does two things instead of writing
to Supabase:

1. Stashes the current order in `localStorage` (so reopening the editor in
   the same browser picks up where you left off).
2. Downloads a CSV (`kyle-rankings-YYYY-MM-DD.csv` /
   `wesley-rankings-YYYY-MM-DD.csv`) with columns `rank,player_key,name,team,pos`.

To actually publish a new ranking, open the CSV and manually copy each
row's `rank` into that player's `kyle` or `wesley` field in
`js/players-data.js` (matched by `player_key`, i.e. `name|TEAM` lowercase
name / uppercase team), then commit and push — same as today's manual
process, just with the ranks worked out in the UI instead of by hand.

### When real Supabase auth goes live

1. Fill in real values in `js/config.js`.
2. Run `supabase/schema.sql` and `supabase/seed_kyle_wesley.sql` against
   the real project (have Kyle and Wesley actually sign up first, per the
   comment at the top of that seed file).
3. Remove everything listed above under "What it touches" — the override
   objects/functions/branches in `js/auth.js` and `rankings-editor.html`,
   and decide on `supabase/functions/login/index.ts`'s `LOGIN_OVERRIDES`.
4. Delete this file, or at least this section.
