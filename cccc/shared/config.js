/* =====================================================================
   CONNECTION SETTINGS — the only file you edit to point the apps at a
   different Supabase project.
   The anon key is PUBLIC by design (it is in every visitor's browser).
   Your data is protected by the Row Level Security rules in
   supabase/004_cccc_online_qr.sql, not by hiding this key.
   ===================================================================== */
window.CCCC_CONFIG = {
  SUPABASE_URL: 'https://qtkoxzuedxvqoktobtyg.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0a294enVlZHh2cW9rdG9idHlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyOTQ3MzcsImV4cCI6MjEwNDg3MDczN30.uP1R_1I-prr6wdDkiabTjzgZNYRV0qiYXfEZB8aq7iA',
  // CAPTCHA (Cloudflare Turnstile) for the QR page and counter pairing. Empty = off.
  // To turn it on: first switch CAPTCHA on in Supabase (Authentication -> Attack Protection),
  // then paste the Turnstile *site* key here. NEVER paste the secret key in this file:
  // the secret key goes only into Supabase.
  CAPTCHA_SITE_KEY: '',
  APP_VERSION: '5.0.0',
};
