# Stage 1 — Database setup (Supabase Postgres)

This is the foundation step of the re-platform. The goal: stand up a real
Postgres database **alongside** the live Google Sheets system, with zero impact
on production. Nothing here changes the customer site or the team dashboard yet —
that happens at the cutover, after verification.

## What you (the owner) need to do

1. **Create a Supabase project** at https://supabase.com (free tier is fine).
   - Pick a region close to Israel (e.g. `eu-central-1` / Frankfurt) for speed.
   - Choose a strong database password and save it.

2. **Get the two connection strings** (Supabase → Project Settings → Database →
   Connection string):
   - **Transaction pooler** (port `6543`) → this is `DATABASE_URL` (runtime app).
   - **Direct connection** (port `5432`) → this is `DIRECT_DATABASE_URL`
     (migrations only).

3. **Send me both strings** (with the password filled in). I'll store them as
   Vercel environment variables scoped to the `replatform` preview — never
   committed to git. For local work they go in a `.env` file (gitignored; see
   `.env.example`).

> Use a **separate Supabase project for staging vs. production** when we get to
> cutover. For now one project is enough to build and verify against.

## What I'll do (no production impact)

1. `npm install` in the `replatform` worktree (adds Drizzle + the Postgres
   driver — all isolated to this branch).
2. Generate the SQL migration from the schema (`lib/db/schema.ts`) and apply it
   to your Supabase project (`npm run db:generate` → `npm run db:migrate`).
3. Build the **repository layer** that mirrors the current `lib/sheets.js`
   functions (same names/signatures) against Postgres.
4. Write a **backfill script** that copies the existing catalog + orders + items
   from Google Sheets into Postgres, then a **verification pass** (row counts and
   totals must match).
5. Only after that: switch `api/*.js` to the Postgres repository (the cutover),
   reviewed on the `replatform` Vercel preview before anything reaches `main`.

## Commands (for reference)

```bash
npm install                 # install deps (run inside the worktree)
npm run db:generate         # generate SQL migration from schema.js
npm run db:migrate          # apply migrations (uses DIRECT_URL)
npm run db:verify           # confirm the 8 tables exist
npm run db:studio           # browse the DB in Drizzle Studio
```

> Run the DB commands (`db:migrate`, `db:verify`, `db:studio`) in your own
> Terminal — the assistant's sandboxed shell can't open raw database
> connections (HTTPS only). Your machine and Vercel both reach Supabase fine.

## Schema overview (`lib/db/schema.ts`)

| Table | Purpose |
|---|---|
| `settings` | Key/value, mirrors the הגדרות sheet |
| `products` | Catalog, mirrors the מוצרים sheet |
| `customers` | Keyed by normalised phone (new — supports repeat customers/payments) |
| `orders` | Mirrors the הזמנות sheet (cols A:Y) + payment summary |
| `order_items` | Mirrors the פריטי הזמנות sheet + actual-weight fields (Stage 2) |
| `payments` | One per order — J5 authorize/capture lifecycle (Stage 4/5) |
| `transactions` | Append-only log of each processor call/webhook (idempotent) |
| `audit_log` | Append-only audit trail |

Conventions: **money = integer agorot** (₪1 = 100), **weights = numeric kg**,
Hebrew status/fulfilment values stored verbatim so existing contracts hold.
**No card data is ever stored** — only processor reference tokens.
