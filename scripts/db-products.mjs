// List every product currently in Postgres, with all details, to verify the
// backfill. Run in your terminal:  npm run db:products
import clientLib from '../lib/db/client.js';

const { db, schema } = clientLib;

setTimeout(() => {
  console.error('TIMEOUT after 15s — DB unreachable?');
  process.exit(2);
}, 15000);

function pad(s, n) {
  s = String(s == null ? '' : s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

try {
  const rows = await db.select().from(schema.products);
  rows.sort((a, b) => a.department.localeCompare(b.department, 'he') || a.name.localeCompare(b.name, 'he'));

  const byState = { active: 0, oos: 0, hidden: 0 };
  rows.forEach((r) => {
    byState[r.state] = (byState[r.state] || 0) + 1;
  });

  console.log('Total products in Postgres: ' + rows.length);
  console.log('By status — active: ' + byState.active + ' | אזל(oos): ' + byState.oos + ' | hidden: ' + byState.hidden);
  console.log('');
  console.log(
    pad('NAME', 28) + pad('DEPT', 10) + pad('UNIT', 8) + pad('PRICE/UNIT', 11) + pad('₪', 7) + pad('STATE', 8) + pad('WEIGHT', 8) + 'IMG',
  );
  console.log('-'.repeat(88));
  for (const r of rows) {
    console.log(
      pad(r.name, 28) +
        pad(r.department, 10) +
        pad(r.unit, 8) +
        pad(r.priceUnit, 11) +
        pad((r.priceAgorot / 100).toFixed(2), 7) +
        pad(r.state, 8) +
        pad(r.weightPerUnitKg == null ? '-' : r.weightPerUnitKg, 8) +
        (r.imageUrl ? 'yes' : 'fallback'),
    );
  }
  console.log('\n✅ ' + rows.length + ' products listed.');
  process.exit(0);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
