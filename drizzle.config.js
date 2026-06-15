const { defineConfig } = require('drizzle-kit');

// Migrations run against the DIRECT/session connection (port 5432), not the
// PgBouncer transaction pooler (6543) — DDL needs a session. The runtime app
// uses the pooled connection instead (see lib/db/client.js).
// `generate` works offline (no URL needed); `migrate`/`push`/`studio` need one.
// DIRECT_URL is Supabase's Drizzle convention (session-mode connection on 5432).
const url =
  process.env.DIRECT_URL || process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '';

module.exports = defineConfig({
  schema: './lib/db/schema.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  casing: 'snake_case',
});
