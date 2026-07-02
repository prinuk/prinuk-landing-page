// One-off: upsert key/value rows into the settings table.
// Usage: node --env-file=.env scripts/set-setting.mjs key=value [key=value ...]
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (is the --env-file present?)');
  process.exit(1);
}

const pairs = process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  if (i < 0) { console.error('Bad arg (expected key=value): ' + a); process.exit(1); }
  return [a.slice(0, i), a.slice(i + 1)];
});
if (!pairs.length) { console.error('No key=value pairs given.'); process.exit(1); }

setTimeout(() => { console.error('TIMEOUT after 15s.'); process.exit(2); }, 15000);

const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 12 });
try {
  for (const [key, value] of pairs) {
    await sql`
      insert into settings (key, value, updated_at) values (${key}, ${value}, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
    console.log('set ' + key + ' = ' + value);
  }
  const rows = await sql`select key, value from settings where key in ${sql(pairs.map((p) => p[0]))} order by key`;
  console.log('now in DB:', rows.map((r) => r.key + '=' + r.value).join(', '));
  await sql.end();
  process.exit(0);
} catch (e) {
  console.error('FAILED:', e.message);
  await sql.end().catch(() => {});
  process.exit(3);
}
