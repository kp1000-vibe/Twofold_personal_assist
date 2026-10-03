# Twofold: project guide for Claude

**Twofold. The family that runs itself.** An AI chief of staff for a household, in the spirit of Instinct and Muse, but for the whole family, and built on **Jev (TypeSafe) plus Claude** so it can watch everything cheaply. Founder: Pat (Kunal Patro), a product manager building this nights and weekends. Plan: invite only beta, prove retention, then raise.

## How to work with Pat
- **Be brutally honest and play devil's advocate.** Challenge ideas, point out risks and weak spots directly. Never just agree.
- **Never use dashes or em dashes** in replies or user facing copy. Restructure the sentence instead.
- Replies: casual, short, plain words ("u", "ur" is how Pat writes; matching it is fine). He is a PM, not an engineer: explain what changed for users, not the code.
- Pat approves direction; ask before anything expensive to redo, anything that spends money, or anything destructive in production data.
- Secrets never go in the repo, in chat, or in Vercel. Edge function secrets live in Supabase; CI secrets live in GitHub.

## Architecture
| Piece | Where |
|---|---|
| Web app (Vite, React, TypeScript) | `web/`, hosted on Vercel at https://web-pearl-one-14.vercel.app, auto deploys from `main` (Root Directory `web`) |
| Phone apps (Capacitor 8) | `web/android`, `web/ios`, app id `com.twofold.family` (permanent once published; change before first store upload if a domain is bought) |
| Backend | One Supabase edge function `api` at `/functions/v1/api/<route>` (`supabase/functions/api`), JWT checked in code (`verify_jwt` off) |
| Database | Supabase project `hdfaafhkeferipgeoxsf`, Postgres with RLS on every table, migrations in `supabase/migrations` (0001 to 0012, all applied) |
| Scheduled jobs | pg_cron calls `public.call_api(route)` with the Vault secret `twofold_cron_secret` (header `x-cron-secret`) |
| CI | `.github/workflows/deploy-functions.yml` deploys `api` on every push touching `supabase/functions` (needs GitHub secret `SUPABASE_ACCESS_TOKEN`, set). `android.yml` builds a test APK artifact; `ios.yml` compiles for the simulator. |

### The two minds (`shared/ai.ts`)
- **Jev** (`jev()`): typed judgments (noul, choice, score) for fractions of a cent. Used for routing, triage, safety screening, scoring risks, gating alerts. Never writes. Weak at arithmetic, dates and writing: do those in code.
- **Claude** (`claude()`, `claudeJson()`): writing, planning, tool use. Model chosen by Jev difficulty: Haiku 4.5, Sonnet 5, Opus 5.5. Every call is logged to `ai_calls` with cost and a "without Jev" baseline.
- Rule of thumb: code measures, Jev judges, Claude writes only the few things that matter.

### Key backend modules (`supabase/functions/api/shared`)
- `agent.ts` `runAgent()`: specialists picked by Jev, tools, memories, budget lite mode, teen mode, family thread mode.
- `trust.ts`: every side effect goes through rules (auto with 5 min undo, ask, never), activity log with undo, `notify()` (quiet mode, push, texts).
- `family.ts`, `familyAgent.ts`: households, family tools, proposals (driver picker from shared calendars, weekly chore plan, grocery autopilot, school email extraction), `decideProposal()`, hourly `runFamilyAgent()`.
- `sources.ts`, `ics.ts`: school and daycare plugins. iCal feeds (repeats, EXDATE, RECURRENCE-ID, DST) synced every 3 h onto `family_events`; family forwarding inbox via Postmark.
- `premortem.ts` (Sunday week check), `replay.ts` (decision replay), `plan.ts` (plans and monthly AI budgets), `safety.ts` (teen screening), `channels.ts` and `inbound.ts` (iMessage, SMS, WhatsApp), `push.ts` and `fcm.ts` (web push, Firebase, APNs).

### Routes (`routes/`)
chat, family-chat, family-act, family-sources, phone, reflect, account, execute-action, undo, google-oauth, sync-inbox, daily-brief, reminders, jobs, insights, inbound-twilio, inbound-sendblue, inbound-email.

### Cron schedule
sync-inbox every 10 min; reminders every 5 min (also rule approved actions and chore reminders); jobs every 2 min; daily-brief hourly at :02; insights hourly at :07 (automations, daily scan, friction radar, Sunday week check at 18:00 local, decision replay at 11:00, family agent: drivers hourly, chores Sunday 16:00, groceries 09:00, feeds every 3 h).

## Product today (what users get)
- **Home** (first screen): today's chores, quick add with who, when and repeat; rides with no driver; streaks; Twofold suggestions; week check.
- **Family**: WhatsApp style group chat with Twofold (photos are read); lists and chores with fairness meter; family calendar with "I will drive"; shared money with settle up (adults only); School and daycare plugins; People and invites (adult, teen with parent consent, kids under 13 as profiles only). Private by default.
- **Personal assistant**: chat with memories, decisions, goals, people, Gmail and Calendar (approval first), automations, decision replay, Sunday week check, texting.
- **Plans**: Free $1 AI a month, Plus $9.99 ($6), Pro $24.99 ($20). Past 100% lite mode, past 150% paused. No Stripe yet; "I want Plus" collects intent.
- **Teens**: full AI with Jev screening in and out, flags in Admin safety queue, no Gmail, no money.

## Secrets (names only)
Supabase edge function secrets: `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (set). Optional, not set yet: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID`, `TWILIO_FROM`, `TWILIO_WHATSAPP_FROM`, `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM`, `FCM_SERVICE_ACCOUNT`, `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_SANDBOX`, `POSTMARK_INBOUND_ADDRESS`.
Vault: `twofold_cron_secret`, `twofold_token_key` (AES key for Google tokens), `twofold_vapid_private`, `twofold_webhook_key`.
GitHub: `SUPABASE_ACCESS_TOKEN` (set); later `GOOGLE_SERVICES_JSON`, `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
The web publishable key in `web/.env.production` is public by design.

## Open items (most important first)
1. **Clean up QA test data**: household "QA House", users `qa.parent@example.com` and `qa.partner@example.com`, and the `qa` schema in the database. Their password was shared in a chat, so delete them.
2. **Google verification** (blocks growth past 100 Gmail users): buy a domain, host the privacy page at a real `/privacy` path, OAuth screen, demo video, CASA security assessment.
3. **Phone push**: Firebase project (`google-services.json` to GitHub, service account to Supabase) and APNs key; store accounts (Google Play, Apple Developer). Then `VITE_NATIVE_PUSH=1` is set by CI automatically.
4. **Texting**: Sendblue (iMessage, SMS fallback) or Twilio (SMS needs A2P 10DLC). WhatsApp only for EU numbers (Meta bans AI assistants elsewhere).
5. **Family inbox**: Postmark account, set `POSTMARK_INBOUND_ADDRESS`, paste the webhook from Settings (admin) into Postmark.
6. **Book and buy** (Phase 2): cloud browser (Browserbase) plus a long running worker. Not built.
7. Stripe for paid plans; prompt caching for chores; move first run to Family; real users (5 families) before more features.
8. Pat works at Intuitive Surgical: keep Twofold off work devices and check the employment agreement before raising.

## How to check work
- Backend type check: `cd supabase/functions/api && deno check index.ts`
- Web: `cd web && npm run build`; phone shells: `npx cap sync`
- Deploy backend: push to `main` (GitHub Action). Apply new SQL as a new numbered migration file and through Supabase.
- Health: `select public.call_api('insights')` then read `net._http_response`, function logs, and `get_advisors` (security).
- Remaining advisor warnings are intentional: admin functions check `is_admin()` inside; server only tables have RLS with no policies.
