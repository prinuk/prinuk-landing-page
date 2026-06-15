/**
 * Database client (Drizzle + postgres.js), serverless-safe (CommonJS).
 *
 * On Vercel each function invocation may reuse a warm container, so we cache a
 * single connection on the module/global scope. Use the Supabase TRANSACTION
 * POOLER connection string (port 6543) for DATABASE_URL — it tolerates many
 * short-lived serverless connections. Because PgBouncer runs in transaction
 * mode, prepared statements must be disabled (`prepare: false`).
 *
 * DIRECT_URL (port 5432) is used only by drizzle-kit for migrations
 * (see drizzle.config.js), never by the runtime app.
 */
const { drizzle } = require('drizzle-orm/postgres-js');
const postgres = require('postgres');
const schema = require('./schema');

function createClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Configure the Supabase pooled connection string.');
  }

  const sql =
    global.__prinukSql ||
    postgres(url, {
      prepare: false, // required for the PgBouncer transaction pooler
      max: 1, // one connection per warm serverless container
      idle_timeout: 20,
    });

  if (!global.__prinukSql) global.__prinukSql = sql;

  return drizzle(sql, { schema, casing: 'snake_case' });
}

const db = global.__prinukDb || createClient();

if (!global.__prinukDb) global.__prinukDb = db;

module.exports = { db, schema };
