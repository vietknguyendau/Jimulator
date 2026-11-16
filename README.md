# JIMULATOR Golf Simulator League

The league site for the JIMULATOR 5 Event Championship: public schedule, event pages, official results, season standings and rules, plus a commissioner office for running each event from setup to published results.

**Stack:** React + TypeScript (Vite) on **Vercel**, **Supabase** (Postgres, Auth, row-level security), code on **GitHub**.

Without Supabase keys the app runs as a **demo league** in the browser, so you can deploy to Vercel and click around before setting up the database. Demo commissioner login: `commissioner@jimulator.demo` / `jimulator`.

---

## How the league works in the app

| Rule | Where it's enforced |
|---|---|
| 8-player maximum, exactly 5 events per season | Database triggers and constraints |
| **Up to 4 players per day.** Each event has 1 or 2 sessions (one group on the single simulator) | `event_sessions` (child of `events`) |
| 8 players → 4 on Day 1, 4 on the **next calendar day** (America/Chicago). 4 players → one session | Session date trigger + lock checks |
| One session per player per event; a 5th assignment to a session is refused | `unique (event_id, player_id)` + assignment trigger |
| Same course, tees and sim settings for both days; setup locked and handicaps confirmed before play | `lock_event()`. Scores can't be entered until the event is locked |
| 9-hole Course Handicap from GHIN index, 80% allowance, rounded to nearest stroke | `handicap_strokes()` (SQL) and `src/lib/handicap.ts` |
| Day 1 scores saved, Day 2 entry resumes later; public sees **"Day 2 pending"**; scores private until published | `round_scores` RLS + event phase |
| Finalize when every session is resolved and every player is Completed / DNF / Did not attend | `resolve_session()`, `publish_event()` |
| One combined leaderboard by net; points awarded once; ties split (cross-day too); next player skips shared positions | `publish_event()` and `src/lib/leaderboard.ts` |
| Points table picked from the total field across both days, counting **starters or finishers** (commissioner setting) | `league_settings.field_size_basis` |
| Field sizes other than 4 or 8 can't be published until the commissioner resolves them | `publish_event()` refuses with a clear message |
| Season standings, tiebreakers (1sts → 2nds → 3rds → lowest cumulative net → playoff) | `src/lib/standings.ts` |

### Commissioner workflow (per event)
1. **Setup:** course, tees, 9-hole par/rating/slope, simulator settings.
2. **Sessions:** Day 1 date and start time; add Day 2 if 5+ players (defaults to the next day).
3. **Groups:** assign each player to Day 1 or Day 2, up to 4 per session.
4. **Lock & confirm handicaps:** review each player's index → 9-hole CH → 80% strokes, then lock. You can unlock again only until the first score is entered.
5. **Scores:** enter hole-by-hole and save. Sign out after Day 1 if you like; it's all in the database. Mark each day complete when everyone is Completed, Did not finish or Did not attend.
6. **Publish:** preview the combined leaderboard and points, then publish. **Unpublish to correct** takes results down (scores go private again) so you can fix a mistake.

---

## Deploy it (about 20 minutes)

### 1. GitHub
1. Create a **private** repo, e.g. `jimulator`.
2. Upload everything in this folder (not `node_modules` or `dist`), and commit.

### 2. Supabase
1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. **SQL Editor → New query:** paste and run each file in `supabase/migrations/`, **in filename order**:
   1. `20261116000001_core.sql`
   2. `20261116000002_event_sessions.sql`
   3. `20261116000003_event_workflow.sql`
3. Run `supabase/seed.sql` for the demo season (8 players, Event 1 split across Mon Nov 2 / Tue Nov 3 with official results, Event 2 showing "Day 2 pending"). **For a clean real season**, skip the seed and run this instead:
   ```sql
   insert into league_settings (id, season_year) values (1, 2026);
   select app_private.create_season_core(2026);   -- creates Events 1–5
   ```
   then add players in the app.
4. **Authentication → Users → Add user:** create the commissioner account with an email and password (tick "Auto Confirm User"). Then in the SQL Editor:
   ```sql
   insert into commissioners (user_id)
   select id from auth.users where email = 'YOUR-EMAIL@example.com';
   ```
5. **Authentication → Sign In / Providers:** you can turn off "Allow new users to sign up". Nobody else needs an account; the public pages don't require login.
6. **Project Settings → API:** copy the **Project URL** and the **anon public** key.

> Using the Supabase CLI instead? `supabase link` then `supabase db push`, and `supabase db reset` locally runs `seed.sql` automatically.

### 3. Vercel
1. **Add New → Project →** import the GitHub repo. Framework preset: Vite (auto-detected).
2. **Environment Variables:** add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from step 2.6.
3. Deploy. Every push to `main` redeploys.

Sign in at **Commissioner** in the top menu. Sessions persist on the device, so Day 1 scores are waiting when you come back on Day 2.

---

## Before the first real event
- **Handicap indexes:** the seed uses placeholder indexes. Update each player's current GHIN index in **League office → Players** before locking an event.
- **Course ratings:** the seed's course ratings and slopes are placeholders. Use the 9-hole rating, slope and par your simulator software shows for the course and tees you pick.
- **Field-size rule:** the default is **Starters** (finishers + DNF; no-shows never count). Change it in **League office → Field-size rule** if the league agrees on Finishers.
- **New season:** in the Supabase SQL editor run `select app_private.create_season_core(2027); update league_settings set season_year = 2027;`. That creates Events 1–5 for the new season and switches the site to it; past seasons stay in the database.

## Decisions worth knowing
- **Handicap rounding:** the rules say convert, apply 80%, then round, so the app rounds once at the end (halves round up). WHS proper rounds the Course Handicap first; this can differ by a stroke on rare .5 cases.
- **Lock timing:** scoring is blocked until the event is locked, and the commissioner page warns if Day 1's start time has passed without a lock. It doesn't hard-block a late lock, so a forgotten lock can't strand an event.
- **Unresolved field sizes:** 5-, 6- or 7-player fields can be scheduled and scored, but publishing is refused until the league decides how to score them. Add rows to `points_tables` for that field size to resolve it.
- **Ties split points** to two decimals (e.g. a three-way tie for 1st in an 8-player event is 13.33 each).
- **DNF players** have no position and earn zero points. Under the Starters rule they still count toward field size.

## Develop and test
```bash
npm install
npm run dev        # demo league at http://localhost:5173 (no Supabase needed)
npm test           # 37 tests: rules engine, the five acceptance checks, and the SQL migrations run in PGlite (Postgres in WASM)
npm run build      # type-check + production build
npx tsx scripts/generate-seed.ts   # regenerate supabase/seed.sql from src/data/demoSeed.ts
```
For local dev against Supabase, copy `.env.example` to `.env.local` and fill in the two values.

The acceptance checks live in `tests/acceptance.test.ts` (through the app's data layer) and `tests/db.test.ts` (against the real migrations, RLS and seed):
1. Monday 4 + Tuesday 4 → one result on the 8-player table.
2. No 5th assignment to either session; no player in both sessions.
3. Cross-day tie for 1st → 14.5 each; next player finishes 3rd.
4. Day 1 scores survive sign-out and return on sign-in; public sees "Day 2 pending" with no scores until published.
5. Four-player single-day event → 12, 9, 6, 3.

## Logo and app icon
The league logo is `public/logo.jpg` (home page hero and link previews). The badge is cropped square into `public/icon-512.png`, `icon-192.png`, `apple-touch-icon.png` and `favicon-32/48.png`, and `public/manifest.webmanifest` lets players add the site to their phone's home screen (Safari: Share → Add to Home Screen; Chrome: menu → Install app). To swap the logo, replace those files with the same names and sizes.

## Project layout
```
src/lib/          rules engine: points, handicap, leaderboard, scheduling, standings, time zone
src/data/         Supabase data layer, local demo store, demo season
src/pages/        public pages (dashboard, schedule, event, rules) and commissioner office
supabase/         migrations (tables, triggers, RLS, workflow functions) and seed.sql
tests/            unit, acceptance and database tests
```
