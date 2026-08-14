// Edge Function: login
//
// The client never calls supabase-auth's password sign-in directly.
// It always goes through this function instead, because only server
// code can:
//   1. See the caller's real IP, to enforce "10 failed tries per IP,
//      then lock that IP for 10 minutes."
//   2. Tell "no such account" apart from "wrong password" -- GoTrue's
//      own signInWithPassword deliberately returns the same generic
//      error for both, and it only accepts an email, not a username.
//
// Deploy with: supabase functions deploy login --no-verify-jwt
// (--no-verify-jwt because signed-out visitors need to be able to
// call this to log in in the first place.)

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 10 * 60 * 1000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('cf-connecting-ip') || '0.0.0.0';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let identifier: string, password: string;
  try {
    const body = await req.json();
    identifier = String(body.identifier || '').trim();
    password = String(body.password || '');
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (!identifier || !password) return json({ error: 'bad_request' }, 400);

  const ip = clientIp(req);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // --- lockout check: last MAX_ATTEMPTS failed attempts from this IP ---
  const { data: recentFails } = await admin
    .from('login_attempts')
    .select('created_at')
    .eq('ip', ip)
    .eq('success', false)
    .order('created_at', { ascending: false })
    .limit(MAX_ATTEMPTS);

  if (recentFails && recentFails.length >= MAX_ATTEMPTS) {
    const tenthMostRecent = new Date(recentFails[MAX_ATTEMPTS - 1].created_at).getTime();
    const lockUntil = tenthMostRecent + LOCKOUT_MS;
    const now = Date.now();
    if (now < lockUntil) {
      return json({
        error: 'locked',
        retryAfterSeconds: Math.ceil((lockUntil - now) / 1000),
      }, 423);
    }
  }

  async function recordAttempt(success: boolean) {
    await admin.from('login_attempts').insert({ ip, identifier, success });
  }

  // --- resolve identifier (email or username) to an email address ---
  let email: string | null = null;

  if (identifier.includes('@')) {
    // listUsers() has no server-side email filter, so this scans a page
    // of users client-side. Fine at this site's scale (dozens/hundreds
    // of accounts); switch to storing email on profiles if it ever grows.
    const { data: byEmail } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const match = byEmail?.users.find((u) => (u.email || '').toLowerCase() === identifier.toLowerCase());
    if (match) email = match.email ?? null;
  } else {
    const { data: profile } = await admin
      .from('profiles')
      .select('id')
      .ilike('username', identifier)
      .maybeSingle();
    if (profile) {
      const { data: userRes } = await admin.auth.admin.getUserById(profile.id);
      email = userRes?.user?.email ?? null;
    }
  }

  if (!email) {
    await recordAttempt(false);
    return json({ error: 'account_not_found' }, 404);
  }

  // --- verify the password using a plain anon client ---
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });

  if (signInError || !signInData.session) {
    await recordAttempt(false);
    return json({ error: 'wrong_password' }, 401);
  }

  await recordAttempt(true);
  return json({
    session: signInData.session,
    user: signInData.user,
  });
});
