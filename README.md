# Twofold (working name)

Personal assistant with two minds: Jev (TypeSafe) makes the fast cheap calls, Claude does the writing and planning.

- web/            React app (Vite). Deploy the web/dist folder to Netlify.
- supabase/       Database migration and the single `api` edge function (routes: chat, google-oauth, sync-inbox, daily-brief, execute-action, reminders).

Live pieces
- Supabase project: hdfaafhkeferipgeoxsf (tables, RLS, Vault secrets, cron jobs every 5 and 10 minutes plus hourly brief)
- Netlify site: twofold-beta.netlify.app

Edge function secrets to add (Supabase dashboard > Edge Functions > Secrets)
- ANTHROPIC_API_KEY      required
- OPENROUTER_API_KEY     or TYPESAFE_API_KEY for Jev (without one, Claude Haiku stands in and costs more)
- GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   for Gmail and Calendar

Google Cloud OAuth client
- Type: Web application
- Authorized redirect URI: https://hdfaafhkeferipgeoxsf.supabase.co/functions/v1/api/google-oauth
- Scopes: openid, email, gmail.readonly, gmail.send, calendar.events
- Keep it in Testing and add up to 100 beta testers as test users, then give them a Gmail slot in the Admin page.
