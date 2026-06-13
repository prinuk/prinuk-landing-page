// Quick connectivity + schema check against the Postgres DB.
// Run with:  npm run db:verify   (reads DATABASE_URL from .env)
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (is .env present?)');
  process.exit(1);
}

// Force exit if the connection stalls, so this never hangs forever.
setTimeout(() => {
  console.error('TIMEOUT after 15s — could not reach the database.');
  process.exit(2);
}, 15000);

const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 12 });

const EXPECTED = [
  'audit_log', 'customers', 'order_items', 'orders',
  'payments', 'products', 'settings', 'transactions',
];

try {
  const tables = (
    await sql`select table_name from information_schema.tables
             where table_schema = 'public' order by table_name`
  ).map((r) => r.table_name);

  const enums = (
    await sql`select typname from pg_type
             where typnamespace = 'public'::regnamespace and typtype = 'e'
             order by typname`
  ).map((r) => r.typname);

  console.log('TABLES (' + tables.length + '):', tables.join(', ') || '(none)');
  console.log('ENUMS  (' + enums.length + '):', enums.join(', ') || '(none)');

  const missing = EXPECTED.filter((t) => !tables.includes(t));
  if (missing.length) {
    console.log('MISSING expected tables:', missing.join(', '));
    console.log('RESULT: ❌ migration incomplete');
    process.exit(1);
  }
  console.log('RESULT: ✅ all 8 expected tables present');
  process.exit(0);
} catch (e) {
  console.error('ERROR:', e.message, '| code:', e.code || '');
  process.exit(1);
}
