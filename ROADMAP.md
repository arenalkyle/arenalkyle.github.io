# Roadmap: turning this into a real business

This is a scoping doc, not a build log — nothing here is implemented
yet. It exists so whoever (human or agent) picks up any of these next
has the shape of the work up front instead of re-deriving it. Pull one
section into an actual plan/PR when you're ready to build it.

Priority order, and why: **Stripe first.** Nothing on the site can
charge anyone today (`set_my_subscription_tier()` and
`submit_expert_review()` both just apply the change immediately — see
the `STUB` comments in `supabase/schema.sql`). Every other idea here
is downstream of money actually being able to move.

---

## 1. Stripe integration

Two independent payment flows need wiring: recurring **subscriptions**
(subscriptions.html) and one-off **Expert Review** purchases
(expert-reviews.html). Both share the same infrastructure, so build
that shared layer first.

### 1a. Shared infrastructure

- **Stripe account setup**: create the 3 recurring Prices (Pro Bowl
  $7.50/mo, MVP $15/mo, Hall of Fame $25/mo) in the Stripe Dashboard
  (test mode first). Note the Price IDs — they're server-side only,
  never sent from the client (see security note below).
- **New table `billing_customers`** (don't add Stripe fields to
  `profiles` — that table's `select` policy is `using (true)`, i.e.
  world-readable, and a Stripe customer ID doesn't need to be public):
  ```sql
  create table public.billing_customers (
    user_id uuid primary key references auth.users(id) on delete cascade,
    stripe_customer_id text not null unique,
    created_at timestamptz not null default now()
  );
  -- RLS: owner can select their own row; only service-role (edge
  -- functions) ever writes to it, so no insert/update policies at all.
  alter table public.billing_customers enable row level security;
  create policy billing_customers_select_own on public.billing_customers
    for select using (user_id = auth.uid());
  ```
- **New table `stripe_webhook_events`** for idempotency — Stripe *will*
  redeliver events, and a webhook handler must be safe to run twice:
  ```sql
  create table public.stripe_webhook_events (
    id text primary key,               -- Stripe event.id
    processed_at timestamptz not null default now()
  );
  -- no RLS policies at all -- only the service-role webhook function touches it.
  alter table public.stripe_webhook_events enable row level security;
  ```
  Webhook handler: `insert into stripe_webhook_events (id) values ($1)`
  first, inside a transaction; if that insert fails on the primary key
  conflict, it's a redelivery — return 200 immediately without
  reprocessing.
- **New Edge Function `stripe-webhook`** (`supabase/functions/stripe-webhook/`):
  - Verifies the signature with `STRIPE_WEBHOOK_SECRET` (set via
    `supabase secrets set`, never hardcoded).
  - Deploy with `--no-verify-jwt` (Stripe calls this directly, no
    Supabase auth header).
  - Uses the **service role key** to write to Postgres — it bypasses
    RLS entirely, so it can update `profiles.subscription_tier`
    directly without going through `set_my_subscription_tier()`.
  - Handles at minimum: `checkout.session.completed`,
    `customer.subscription.updated`, `customer.subscription.deleted`,
    `invoice.payment_failed`.
- **Security note**: the client must never tell the server which Price
  ID or amount to charge. Every checkout-creating function takes a
  *tier name* (`'premium'`/`'elite'`/`'legendary'`) or a *review type*
  string from the client, and looks up the actual Stripe Price ID / a
  server-computed price in its own code — same trust model the site
  already uses (e.g. `submit_expert_review()` computes `price` itself
  server-side instead of trusting a client-sent amount).

### 1b. Subscriptions (subscriptions.html)

- **New Edge Function `create-subscription-checkout`**: authenticated
  (verify-jwt on), takes `{ tier }`, looks up (or creates, storing into
  `billing_customers`) the caller's Stripe Customer, creates a Checkout
  Session in `mode: 'subscription'` for that tier's Price, `success_url`
  / `cancel_url` back to `subscriptions.html`, returns the session URL.
- **subscriptions.html**: replace the direct
  `window.sb.rpc('set_my_subscription_tier', ...)` call with a call to
  this function, then `window.location.href = session.url` (redirect to
  Stripe Checkout instead of applying instantly).
- **Webhook logic**: on `checkout.session.completed` (subscription
  mode) or `customer.subscription.updated`, map the Stripe Price ID
  back to a tier and `update profiles set subscription_tier = $tier
  where id = $user_id`. On `customer.subscription.deleted`, set the
  tier back to `'free'`.
- **`set_my_subscription_tier()`**: keep it, but change its guard so
  only an Admin can call it directly (for comps/manual overrides) —
  regular users go through Checkout from here on.
- **Customer Portal** (do this — it's a few lines and saves building
  invoice/cancel/payment-method UI entirely): a
  `create-portal-session` Edge Function that looks up the caller's
  `stripe_customer_id` and returns a Billing Portal session URL. Add a
  "Manage Billing" button on subscriptions.html or profile.html that
  redirects there.

### 1c. Expert Reviews (expert-reviews.html)

Trickier than subscriptions because the request payload (team name,
selected players, notes) needs to survive the round-trip to Stripe and
back, and a request currently gets written to `expert_review_requests`
*before* any payment exists.

Recommended shape — **don't** insert into `expert_review_requests`
until payment is confirmed, so no schema migration (new `status`
value) is needed:

- **New Edge Function `create-review-checkout`**: authenticated, takes
  the same payload `submit_expert_review()` takes today
  (`review_type`, `tier`, `team_name`, `payload`, `notes`), computes
  the price server-side (same logic already in `submit_expert_review()`
  — reuse it), and:
  - If price resolves to **0** (covered by the caller's subscription
    perk), skip Stripe entirely and just call
    `submit_expert_review()` directly like today.
  - Otherwise, create a Checkout Session in `mode: 'payment'` with the
    whole request payload stuffed into `session.metadata` (Stripe
    metadata values must be strings — JSON.stringify the payload), and
    return the session URL.
- **Webhook logic**: on `checkout.session.completed` (payment mode),
  read the metadata back out and call the same insert
  `submit_expert_review()` does (as service role, so bypassing the
  free-credit-quota check that already happened client-side is fine —
  this path only runs for paid requests) to create the
  `expert_review_requests` row, *then* fire the existing "request
  received" flow.
- **expert-reviews.html**: replace the direct
  `window.sb.rpc('submit_expert_review', ...)` call with a call to
  `create-review-checkout`, and redirect to `session.url` when one
  comes back (skip the redirect — same as today — when the response
  says it was free and already submitted).

### 1d. Testing checklist

- `stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook`
  (or the deployed URL) during development.
- Stripe test cards: `4242 4242 4242 4242` (success),
  `4000 0000 0000 0002` (declined).
- Subscribe, confirm `profiles.subscription_tier` updates only after
  the webhook fires (not on Checkout redirect alone — the redirect
  happens before payment necessarily settles).
- Cancel via the Customer Portal, confirm tier reverts to `free`.
- Submit a paid Expert Review, confirm no `expert_review_requests` row
  exists until after webhook delivery, then confirm one appears with
  the right payload.
- Replay a webhook event twice (Stripe Dashboard has a "resend" button)
  and confirm it doesn't double-apply.

---

## 2. Sell to whole leagues

Fantasy is inherently social — a whole league adopting the site
together (or one person paying for the group) is a distribution
channel none of the algorithmic competitors lean into. Two versions,
ship the first before building the second:

### 2a. MVP: Stripe Promotion Codes (no schema changes)

Create a handful of Stripe Promotion Codes (e.g. `LEAGUE20` → 20% off
recurring) and hand them out to league commissioners to share with
their leaguemates at signup. Checkout Sessions support
`allow_promotion_codes: true` — turn that on in
`create-subscription-checkout` above and this needs zero new database
work. Ship this alongside the base Stripe integration, not after it.

### 2b. V2: League Packs (one purchase covers the whole league)

A commissioner buys one subscription that grants the tier to everyone
in their linked league, instead of everyone paying individually.

- **New table `league_subscriptions`**:
  ```sql
  create table public.league_subscriptions (
    id            uuid primary key default gen_random_uuid(),
    platform      text not null check (platform in ('sleeper','espn')),
    league_id     text not null,
    purchased_by  uuid not null references auth.users(id) on delete cascade,
    tier          text not null check (tier in ('premium','elite','legendary')),
    stripe_subscription_id text not null,
    active        boolean not null default true,
    created_at    timestamptz not null default now(),
    unique (platform, league_id)
  );
  ```
- **Entitlement check**: a user's *effective* tier becomes
  `greatest(profiles.subscription_tier, any matching league_subscriptions
  tier for a league_id they have in fantasy_teams)`. This is the fiddly
  part — either (a) compute it as a view/function
  (`effective_subscription_tier(uid)`) that every perk-check RPC calls
  instead of reading `profiles.subscription_tier` directly, or (b) a
  trigger on `fantasy_teams` insert that checks for a matching active
  `league_subscriptions` row and syncs `profiles.subscription_tier` up
  (simpler, but tier "leaks" if the league pack is later cancelled and
  the user never re-synced down — (a) is more correct).
- **UI**: a "Get this for your whole league" flow on subscriptions.html
  — commissioner enters their linked league (from `fantasy_teams`,
  which already stores `league_id`), price scales with league size
  (Sleeper/ESPN both expose roster count), Checkout Session ties the
  Stripe subscription to that `league_id` via metadata, webhook inserts
  the `league_subscriptions` row on success.
- This is meaningfully more engineering than 2a — don't start it until
  the core Stripe flow (section 1) is live and stable.

---

## 3. Longer-term: notifications as a retention hook

The `notifications` table and `notifications.html` inbox already exist
(see CLAUDE.md) — they're currently only ever written by
`admin_respond_expert_review()`. The bigger opportunity is
system-generated notifications: waiver-wire pickups, injury news, bye
weeks coming up, for players a user actually rosters (known from
`fantasy_teams` + `js/fantasy-platforms.js`'s roster fetchers).

Ship in two phases:

- **Phase 1 — email digest** (cheap, no new client work): a scheduled
  Edge Function (Supabase supports cron-triggered functions) that,
  once a day, pulls each user's rostered players (re-using
  `fetchSleeperLeague`/`fetchEspnLeague` logic, moved server-side or
  called from Deno), diffs against an injury-report feed (ESPN's site
  API already used elsewhere in this repo has one), and both (a)
  inserts a row into `notifications` and (b) emails a short digest
  (Resend or Supabase's built-in email have free tiers). This needs a
  `notification_preferences` table (per-user opt in/out, digest time)
  but no new frontend beyond a settings toggle on profile.html.
- **Phase 2 — real push** (bigger lift): Web Push API subscriptions
  stored per-device (`push_subscriptions` table: `user_id`, `endpoint`,
  `p256dh`, `auth`), a service worker registered from the client, and
  the same Phase 1 job pushing instead of (or in addition to) emailing.
  Don't start this until Phase 1 proves people actually want the
  alerts — it's a much bigger surface (service worker lifecycle,
  browser permission UX, VAPID keys) for the same underlying content.

Both phases are pure upside for subscription retention (a tier perk:
"Elite+ get real-time injury alerts") without touching the core
Stripe/rankings/trade-analyzer code at all.

---

## Also worth doing, low effort (mentioned for completeness)

- **Affiliate links** (sportsbook/DFS, Fanatics) on Rankings/Posts/Trade
  Analyzer — no schema or infra changes, just placement + a disclosure
  line. Highest money-per-hour-of-work item in this whole doc; not
  detailed further here because it really is just "add the links."
