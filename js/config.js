// Fill these in after finishing the setup steps in SETUP.md.
// SUPABASE_ANON_KEY is a public key -- safe to ship in client code.
// Real security comes from the Row Level Security policies in
// supabase/schema.sql, not from keeping this key secret.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-PUBLIC-KEY',
  LOGIN_FUNCTION_URL: 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/login',
  TURNSTILE_SITE_KEY: 'YOUR-TURNSTILE-SITE-KEY',
};
