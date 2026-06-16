// Persist the code-map estimated unit weights into products.weightPerUnitKg so
// the DB is the single source of truth (and the weekly sale publish preserves
// them). Only fills EMPTY columns — never clobbers an owner-set value.
//
// Preview by default; pass --apply to write. Examples:
//   npm run weights:fill                 (staging — preview)
//   npm run weights:fill -- --apply      (staging — write)
//   npm run weights:fill:prod -- --apply (production — write; use DIRECT_URL if
//                                         the pooler hangs, see README/notes)
import { eq } from 'drizzle-orm';
import clientLib from '../lib/db/client.js';
import sheets from '../lib/sheets.js';

const { db, schema } = clientLib;
const { getEstimatedUnitWeightKg } = sheets;
const APPLY = process.argv.includes('--apply');

const timeout = setTimeout(() => {
  console.error('TIMEOUT after 25s — DB unreachable? For prod use the DIRECT_URL.');
  process.exit(2);
}, 25000);

function hasWeight(v) {
  return v != null && String(v) !== '' && Number(v) > 0;
}

try {
  const rows = await db.select().from(schema.products);
  rows.sort((a, b) => a.name.localeCompare(b.name, 'he'));

  const alreadySet = rows.filter((r) => hasWeight(r.weightPerUnitKg));
  const toFill = [];
  const noEstimate = [];
  for (const r of rows) {
    if (hasWeight(r.weightPerUnitKg)) continue;
    const est = getEstimatedUnitWeightKg(r.name);
    if (est > 0) toFill.push({ id: r.id, name: r.name, est });
    else noEstimate.push(r.name);
  }

  console.log('Products in DB:                 ' + rows.length);
  console.log('Already have a weight column:   ' + alreadySet.length);
  console.log('Will fill from code map:        ' + toFill.length +
    (APPLY ? '   (APPLYING)' : '   (preview — pass --apply to write)'));
  console.log('No estimate anywhere (stay null): ' + noEstimate.length);
  console.log('');

  if (toFill.length) {
    console.log('— To fill —');
    for (const p of toFill) console.log('  ' + String(p.est).padEnd(6) + 'kg  ←  ' + p.name);
  }
  if (noEstimate.length) {
    console.log('');
    console.log('— No estimate (left null; add manually in /team if needed) —');
    for (const n of noEstimate) console.log('  · ' + n);
  }

  if (APPLY && toFill.length) {
    let n = 0;
    for (const p of toFill) {
      // Sequential (not Promise.all): the Supabase pooler hangs on pipelined queries.
      await db.update(schema.products)
        .set({ weightPerUnitKg: String(p.est), updatedAt: new Date() })
        .where(eq(schema.products.id, p.id));
      n++;
    }
    console.log('\n✓ Updated ' + n + ' products.');
  } else if (APPLY) {
    console.log('\nNothing to update.');
  }

  clearTimeout(timeout);
  process.exit(0);
} catch (err) {
  console.error('Failed:', err.message || err);
  process.exit(1);
}
