# SIF FOREX HUB

A static forex learning and practice site. The Academy, the separate SIF Question assessment section, charts, risk calculator, and simulator open directly without account creation. Sign-in is required for the personal journal and dashboard. Guest Academy progress saves in browser storage; signed-in learners can sync progress to their account.

## Preview locally

From this folder, run `python3 -m http.server 8000` and open `http://localhost:8000/`. A local HTTP server is more reliable than opening individual files. Supabase auth and the TradingView chart need an internet connection and their external services.

## Academy and SIF Question

The beginner curriculum contains 18 modules and 206 lessons. Lesson pages focus on introductions, objectives, explanations, practical examples, labelled schematic visuals, takeaways, mistakes, and summaries. Assessments live separately at `sif-question.html`; each lesson links to its five-question assessment. A score of 4/5 passes and unlocks the next lesson. Failed attempts can be retried, and answer explanations appear after submission.

The JSON lesson sources are in `academy-content/module-01.json` through `module-18.json`. To validate the curriculum and regenerate the compact browser index, run `python3 scripts/build-academy-data.py`. The browser fetches detailed content only when a learner opens that module's lesson or assessment. Progress uses `sifForexAcademyProgress.v2`; the previous four-lesson key is migrated forward without being deleted. Certificates recognize study only, not trading performance or a professional qualification.

## Account and data behavior

The dashboard uses Supabase Auth and reads `public.profiles`. Registration writes `full_name` and `username` to Auth metadata; this source does not create a `profiles` row. The dashboard falls back to Auth metadata if a profile row cannot be read, and does not guess membership status.

The journal requires a Supabase-verified signed-in session. New entries are stored only in this browser under a key scoped to the authenticated user ID; they are not synced to a server or encrypted. Anyone with access to this browser profile or its storage can inspect them. The earlier unscoped journal key is left untouched and is not automatically assigned to an account. A deliberate, owner-approved migration would be needed to import that older data safely.

The simulator is a guest practice tool and stores fictional practice state in this browser profile. It is not synced to an account or connected to a broker. Avoid real or sensitive information, especially on a shared device. Neither tool guarantees profits or prevents losses.

## Supabase setup and safety

The browser client in login, registration, dashboard, and journal needs the project's Supabase URL and a public publishable/anon key. Never use a service-role key, secret key, or JWT signing secret in browser code or a public repository.

Before deployment, confirm that `public.profiles` has `id`, `full_name`, `username`, and `membership`, with `id` corresponding to the authenticated user ID. If profile data is needed, configure and test a trusted server-side signup row-creation path. Keep RLS enabled and verify that an authenticated user can read only their own profile row. Test both new and existing accounts with RLS enabled. Do not apply SQL copied from documentation without matching it to the actual deployed schema and policies.

The additive migration `supabase/migrations/20261126175200_academy_progress.sql` was applied to production with owner approval on 2026-11-26. It creates one JSONB progress row per authenticated user with RLS and owner-only policies; it does not alter `public.profiles` or existing user data. Signed-in Academy and SIF Question sessions can sync progress to this table. Guests save locally, and the app falls back to browser storage if account sync is unavailable. No build or test automatically applies this migration.

The journal is currently local-only. If it must be private across devices or protected against other users of the same browser profile, store entries server-side in an owner-scoped table with verified RLS; that backend is not configured here. PRO/VIP plans and payment processing remain unavailable until a real paid feature is ready.

## Scope and safety

This site is for education and practice, not personalized financial advice or live trade signals. Forex and leveraged trading involve substantial risk; tools and examples do not guarantee profits or prevent losses.
