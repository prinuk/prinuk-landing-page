// Merge duplicate products (same normalized name): keep the "best" row, delete
// the rest. Products are referenced by order_items via a nullable FK (ON DELETE
// SET NULL) and order_items also store the product name, so deleting a duplicate
// catalog row does not harm order history.
//
//   npm run db:dedupe            (dry run — shows what it would do)
//   npm run db:dedupe -- --apply (actually delete)
import { inArray } from 'drizzle-orm';
import clientLib from '../lib/db/client.js';
import sheetsLib from '../lib/sheets.js';

const { db, schema } = clientLib;
const { normalizeProductName } = sheetsLib;
const APPLY = process.argv.includes('--apply');

setTimeout(() => { console.error('TIMEOUT after 20s'); process.exit(2); }, 20000);

// Higher score = better keeper: active > priced > has image > has weight.
function score(p) {
  let s = 0;
  if (p.state === 'active') s += 8;
  else if (p.state === 'oos') s += 4;
  if (p.priceAgorot > 0) s += 2;
  if (p.imageUrl) s += 1;
  if (p.weightPerUnitKg != null) s += 1;
  return s;
}

try {
  const rows = await db.select().from(schema.products);
  const groups = new Map();
  for (const p of rows) {
    const k = normalizeProductName(p.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }

  const toDelete = [];
  for (const [, arr] of groups) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => score(b) - score(a));
    const keep = arr[0];
    const drop = arr.slice(1);
    console.log('KEEP "' + keep.name + '" [' + keep.state + ', ₪' + (keep.priceAgorot / 100) + ']');
    drop.forEach((p) => {
      console.log('   delete "' + p.name + '" [' + p.state + ', ₪' + (p.priceAgorot / 100) + ']');
      toDelete.push(p.id);
    });
  }

  if (!toDelete.length) {
    console.log('✅ No duplicates to remove.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — would delete ' + toDelete.length + ' row(s). Re-run with: npm run db:dedupe -- --apply');
    process.exit(0);
  }

  await db.delete(schema.products).where(inArray(schema.products.id, toDelete));
  console.log('\n✅ Deleted ' + toDelete.length + ' duplicate row(s).');
  process.exit(0);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
