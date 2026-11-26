# SIF FOREX HUB

A static forex learning and practice site. The Academy, charts, risk calculator, and simulator open directly without account creation. Sign-in is required for the personal journal and dashboard. Academy lessons and quizzes save progress only in this browser; progress is not synced to an account.

## Preview locally

From this folder, run `python3 -m http.server 8000` and open `http://localhost:8000/`. A local HTTP server is more reliable than opening individual files. Supabase auth and the TradingView chart need an internet connection and their external services.

## Account and data behavior

The dashboard uses Supabase Auth and reads `public.profiles`. Registration writes `full_name` and `username` to Auth metadata; this source does not create a `profiles` row. The dashboard falls back to Auth metadata if a profile row cannot be read, and does not guess membership status.

The journal requires a Supabase-verified signed-in session. New entries are stored only in this browser under a key scoped to the authenticated user ID; they are not synced to a server or encrypted. Anyone with access to this browser profile or its storage can inspect them. The earlier unscoped journal key is left untouched and is not automatically assigned to an account. A deliberate, owner-approved migration would be needed to import that older data safely.

The simulator is a guest practice tool and stores fictional practice state in this browser profile. It is not synced to an account or connected to a broker. Avoid real or sensitive information, especially on a shared device. Neither tool guarantees profits or prevents losses.

## Supabase setup and safety

The browser client in login, registration, dashboard, and journal needs the project's Supabase URL and a public publishable/anon key. Never use a service-role key, secret key, or JWT signing secret in browser code or a public repository.

Before deployment, confirm that `public.profiles` has `id`, `full_name`, `username`, and `membership`, with `id` corresponding to the authenticated user ID. If profile data is needed, configure and test a trusted server-side signup row-creation path. Keep RLS enabled and verify that an authenticated user can read only their own profile row. Test both new and existing accounts with RLS enabled. Do not apply SQL copied from documentation without matching it to the actual deployed schema and policies.

The journal is currently local-only. If it must be private across devices or protected against other users of the same browser profile, store entries server-side in an owner-scoped table with verified RLS; that backend is not configured here. PRO/VIP plans and payment processing are preview-only and unavailable.

## Scope and safety

This site is for education and practice, not personalized financial advice or live trade signals. Forex and leveraged trading involve substantial risk; tools and examples do not guarantee profits or prevent losses.
