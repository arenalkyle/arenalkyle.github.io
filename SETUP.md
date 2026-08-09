# Setup: wiring up the new backend

The code in this repo is all written and ready to go, but it can't do
anything until a real Supabase project exists behind it. These steps
only need to be done once. None of them can be done for you — they
require creating accounts you own.

## 1. Create the Supabase project

1. Go to supabase.com, sign up, and create a new project (free tier is fine).
2. In the SQL Editor, paste the contents of `supabase/schema.sql` and run it.
   This creates every table, policy, trigger, and RPC the site needs.
3. In Project Settings -> API, copy the **Project URL** and the **anon public**
   key into `js/config.js` (`SUPABASE_URL` and `SUPABASE_ANON_KEY`). The anon
   key is meant to be public — it ships in client code everywhere. Row Level
   Security (defined in schema.sql) is what actually keeps data safe, not
   secrecy of this key.

## 2. Deploy the login Edge Function

The login form calls a Supabase Edge Function (`supabase/functions/login`)
instead of talking to auth directly, so it can enforce the 10-tries/10-minute
IP lockout and tell "no such account" apart from "wrong password."

1. Install the Supabase CLI and run `supabase login`.
2. `supabase link --project-ref YOUR-PROJECT-REF`
3. `supabase functions deploy login --no-verify-jwt`
   (`--no-verify-jwt` is required — signed-out visitors need to be able to
   call this function in order to log in in the first place.)
4. Supabase automatically provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
   `SUPABASE_SERVICE_ROLE_KEY` to every Edge Function at runtime — you don't
   need to set those secrets yourself.
5. Copy the deployed function's URL (shown in the CLI output, or under
   Edge Functions in the dashboard) into `js/config.js` as `LOGIN_FUNCTION_URL`.
   It looks like `https://YOUR-PROJECT-REF.supabase.co/functions/v1/login`.

## 3. Google sign-in

1. In the [Google Cloud Console](https://console.cloud.google.com/), create
   an OAuth 2.0 Client ID (APIs & Services -> Credentials -> Create
   Credentials -> OAuth client ID -> Web application).
   - Authorized JavaScript origin: your GitHub Pages URL, e.g.
     `https://arenalkyle.github.io`
   - Authorized redirect URI: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
2. In the Supabase dashboard: Authentication -> Providers -> Google. Paste in
   the Client ID and Client Secret from step 1, and enable the provider.
3. In Authentication -> URL Configuration, add your GitHub Pages URL to the
   Site URL and Redirect URLs so Google can redirect back to the right page.

## 4. Captcha (Cloudflare Turnstile)

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), go to
   Turnstile and add a new site. Use "Managed" mode — that's the one that
   renders as a simple checkbox for most visitors.
2. Copy the **Site Key** into `js/config.js` as `TURNSTILE_SITE_KEY`.
3. Copy the **Secret Key** into the Supabase dashboard: Authentication ->
   Settings -> Bot and Abuse Protection -> enable Turnstile and paste it in.
   This makes Supabase itself reject sign-ups that don't include a valid
   captcha token, not just the frontend.
   (The Turnstile widget script is already included on every page.)

## 5. Bootstrap the first Admin

`set_user_role` (used by the Admin panel to change roles) can only be
called by an existing Admin — so the very first Admin has to be set
directly in SQL. Sign up for a normal account on the site first, then in
the Supabase SQL editor:

```sql
update public.profiles set role = 'admin' where username = 'your-username';
```

From then on, role changes can be done through the Admin panel itself.

## 6. Migrate Kyle and Wesley

1. Have Kyle and Wesley each create a real account on the site (email/password
   or Google, doesn't matter).
2. In the SQL editor, run `supabase/seed_kyle_wesley.sql`. It seeds their
   accounts with their existing rankings and promotes Kyle to Admin and
   Wesley to Editor. If they signed up with different usernames than `kyle`
   and `wesley`, edit the two `select public.__seed_rankings_by_username(...)`
   calls in that file first.

## 7. Publish

Nothing about GitHub Pages hosting changes — commit and push as usual.
`js/config.js` holding the Supabase URL and anon key is expected to be
public; don't put the Turnstile *secret* key or anything else sensitive
in this repo.

## Testing checklist

- Sign up with email/password, confirm the account appears in Supabase's
  Authentication -> Users list and in the `profiles` table.
- Sign in with the wrong password 10 times in a row from the same network
  and confirm the 11th attempt is locked for ~10 minutes.
- Sign in with a made-up username and confirm the red "account not found"
  message.
- Sign in with Google, confirm a profile row is created with the Google
  avatar and name.
- As a `user`-role account, visit `rankings-editor.html`: it should be
  blurred with a login prompt when signed out, editable when signed in.
  Drag some players, type a rank number directly, save, and refresh to
  confirm it persisted.
- Check "Include My Rankings" on the main board and confirm it blends into
  the Ranker options.
- As the bootstrapped Admin, visit `admin.html`, change another user's role,
  and toggle a permission in the policy matrix.
