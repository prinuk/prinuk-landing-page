// Scan the catalog for duplicate products (same normalized name). Read-only.
//   npm run db:dupes
import clientLib from '../lib/db/client.js';
import sheetsLib from '../lib/sheets.js';

const { db, schema } = clientLib;
const { normalizeProductName } = sheetsLib;

setTimeout(() => { console.error('TIMEOUT after 15s'); process.exit(2); }, 15000);

try {
  const rows = await db.select().from(schema.products);
  const groups = new Map();
  for (const p of rows) {
    const k = normalizeProductName(p.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }

  let dupGroups = 0;
  let dupRows = 0;
  for (const [, arr] of groups) {
    if (arr.length > 1) {
      dupGroups += 1;
      dupRows += arr.length - 1;
      console.log(
        'DUP (' + arr.length + '): ' +
          arr.map((p) => '"' + p.name + '" [' + p.state + ', ₪' + (p.priceAgorot / 100) + (p.imageUrl ? ', img' : '') + ']').join('   |   '),
      );
    }
  }

  console.log('');
  console.log('Total products: ' + rows.length);
  console.log(dupGroups ? '⚠️  ' + dupGroups + ' duplicate name group(s), ' + dupRows + ' extra row(s). Run: npm run db:dedupe' : '✅ No duplicates.');
  process.exit(0);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
