// Shared Supabase client, built from js/config.js. Loaded via the
// supabase-js CDN UMD build (see the <script> tag in each page) so
// this file can stay a plain script with no bundler/build step.
window.sb = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);
