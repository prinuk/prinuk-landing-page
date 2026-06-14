// One-time migration: copy the live Google Sheets data into Postgres.
// Run in YOUR terminal (needs DATABASE_URL + GOOGLE_CREDENTIALS + SPREADSHEET_ID
// in .env; the assistant's sandbox can't reach the DB):
//   npm run db:backfill
//
// It is RE-RUNNABLE: it TRUNCATEs the target tables first, then loads settings,
// products, and the full order history (orders + items + customers). It only
// READS the Google Sheet (never writes to it). audit_log is left untouched.
//
// Notes:
// - Money is converted to integer agorot.
// - The sheet only ever stored the final grand total, so for historical orders
//   estimatedTotal = grandTotal and deliveryFee = 0 (the split wasn't recorded).
//   All NEW orders going forward store the precise breakdown.
// - order_items.productId is left null for backfilled rows (the catalog id
//   wasn't recorded per item); product names are preserved verbatim.
import { sql, count } from 'drizzle-orm';
import sheetsLib from '../lib/sheets.js';
import storeLib from '../lib/store.js';
import clientLib from '../lib/db/client.js';

const { readCatalog, readCatalogSheet, getSheetsClient, getSpreadsheetId } = sheetsLib;
const { addProduct } = storeLib;
const { db, schema } = clientLib;

const ORDERS_SHEET = 'הזמנות';
const ORDER_ITEMS_SHEET = 'פריטי הזמנות';
const ORDER_STATUSES = ['חדש', 'בליקוט', 'נאסף', 'נאסף חלקית', 'נשלח', 'נמסר'];
const FULFILLMENTS = ['משלוח', 'איסוף עצמי'];

// --- helpers ---
function parseNum(v) {
  const n = Number(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n : 0;
}
function toAgorot(v) {
  return Math.round(parseNum(v) * 100);
}
function normPhone(v) {
  const digits = String(v == null ? '' : v).replace(/\D/g, '');
  if (digits.indexOf('9725') === 0 && digits.length === 12) return '0' + digits.slice(3);
  if (/^5\d{8}$/.test(digits)) return '0' + digits;
  return digits;
}
function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function coerceStatus(v) {
  const s = String(v || '').trim();
  return ORDER_STATUSES.includes(s) ? s : 'חדש';
}
function coerceFulfillment(v) {
  let s = String(v || '').trim();
  if (s === 'איסוף') s = 'איסוף עצמי';
  return FULFILLMENTS.includes(s) ? s : 'איסוף עצמי';
}
function mapPick(v) {
  const s = String(v || '').trim();
  return s === 'נאסף' || s === 'חסר' ? s : null;
}

let timeout = setTimeout(() => {
  console.error('\nTIMEOUT after 120s.');
  process.exit(2);
}, 120000);

async function main() {
  console.log('Reading Google Sheets…');
  const [{ settings }, catalogSheet] = [await readCatalog(), await readCatalogSheet()];
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const orderRows = (
    (await sheets.spreadsheets.values.get({ spreadsheetId, range: ORDERS_SHEET + '!A:Y' })).data.values || []
  ).slice(1);
  const itemRows = (
    (await sheets.spreadsheets.values.get({ spreadsheetId, range: ORDER_ITEMS_SHEET + '!A:L' })).data.values || []
  ).slice(1);

  console.log(
    'Sheet contents: ' +
      catalogSheet.products.length +
      ' products, ' +
      orderRows.filter((r) => String(r[1] || '').trim()).length +
      ' orders, ' +
      itemRows.filter((r) => String(r[1] || '').trim()).length +
      ' item rows.',
  );

  console.log('\nClearing target tables…');
  await db.execute(
    sql`TRUNCATE TABLE order_items, payments, transactions, orders, customers, products, settings RESTART IDENTITY CASCADE`,
  );

  // --- settings ---
  console.log('Loading settings…');
  const settingRows = Object.entries(settings)
    .filter(([, v]) => v != null)
    .map(([key, value]) => ({ key, value: String(value) }));
  if (settingRows.length) await db.insert(schema.settings).values(settingRows);

  // --- products ---
  console.log('Loading ' + catalogSheet.products.length + ' products…');
  for (const p of catalogSheet.products) {
    await addProduct({
      name: p.name,
      department: p.department,
      unit: p.unit,
      priceUnit: p.priceUnit,
      price: p.price,
      state: p.state,
      weightPerUnitKg: p.weightPerUnitKg, // '' or number → store handles
      imageUrl: p.image, // raw override only; fallback applied at read time
    });
  }

  // --- orders + items ---
  const itemsByOrder = new Map();
  for (const r of itemRows) {
    const code = String(r[1] || '').trim();
    if (!code) continue;
    if (!itemsByOrder.has(code)) itemsByOrder.set(code, []);
    itemsByOrder.get(code).push(r);
  }

  let okOrders = 0;
  let okItems = 0;
  const failures = [];

  console.log('Loading orders…');
  for (const row of orderRows) {
    const orderCode = String(row[1] || '').trim();
    if (!orderCode) continue;

    try {
      const phone = normPhone(row[4]);
      const fullName = row[3] || '';
      const email = row[14] || '';

      const [c] = await db
        .insert(schema.customers)
        .values({ phone, fullName, email })
        .onConflictDoUpdate({
          target: schema.customers.phone,
          set: { fullName, email, updatedAt: new Date() },
        })
        .returning({ id: schema.customers.id });

      const fulfillment = coerceFulfillment(row[5]);
      const address = row[6] || '';
      let neighborhood = '';
      if (fulfillment === 'משלוח' && address.indexOf(',') !== -1) {
        neighborhood = address.slice(0, address.indexOf(',')).trim();
      }
      const createdAt = parseDate(row[0]) || new Date();
      const grand = toAgorot(row[12]);

      const [o] = await db
        .insert(schema.orders)
        .values({
          orderCode,
          customerId: c.id,
          createdAt,
          updatedAt: parseDate(row[22]) || createdAt,
          fullName,
          phone,
          email,
          fulfillment,
          neighborhood,
          address,
          floor: row[7] || '',
          apartment: row[8] || '',
          notes: row[9] || '',
          status: coerceStatus(row[11]),
          estimatedTotalAgorot: grand,
          deliveryFeeAgorot: 0,
          grandTotalAgorot: grand,
          unpricedItemCount: parseInt(row[13], 10) || 0,
          editToken: row[21] || '',
          collectedBy: row[23] || '',
          pickedAt: parseDate(row[24]),
          customerEmailStatus: row[15] || '',
          customerEmailError: row[16] || '',
          businessEmailStatus: row[17] || '',
          businessEmailError: row[18] || '',
          telegramStatus: row[19] || '',
          telegramError: row[20] || '',
        })
        .returning({ id: schema.orders.id });

      const items = (itemsByOrder.get(orderCode) || []).map((r, i) => ({
        orderId: o.id,
        productId: null,
        productName: r[2] || '',
        department: r[3] || '',
        mode: String(r[4] || '').trim() === 'משקל' ? 'kg' : 'unit',
        quantity: String(parseNum(r[5])),
        orderUnit: r[6] || '',
        unitPriceAgorot: toAgorot(r[7]),
        priceUnit: r[8] || '',
        lineTotalAgorot: r[9] === '' || r[9] == null ? null : toAgorot(r[9]),
        note: r[10] || '',
        pickStatus: mapPick(r[11]),
        sortOrder: i,
      }));
      if (items.length) await db.insert(schema.orderItems).values(items);

      okOrders += 1;
      okItems += items.length;
      if (okOrders % 25 === 0) console.log('  …' + okOrders + ' orders');
    } catch (e) {
      failures.push({ orderCode, error: e.message });
    }
  }

  // --- verify ---
  console.log('\nVerifying row counts in Postgres…');
  const [[pc], [sc], [oc], [ic], [cc]] = [
    await db.select({ n: count() }).from(schema.products),
    await db.select({ n: count() }).from(schema.settings),
    await db.select({ n: count() }).from(schema.orders),
    await db.select({ n: count() }).from(schema.orderItems),
    await db.select({ n: count() }).from(schema.customers),
  ];

  console.log('  products:  ' + pc.n + '  (sheet: ' + catalogSheet.products.length + ')');
  console.log('  settings:  ' + sc.n);
  console.log('  orders:    ' + oc.n + '  (loaded: ' + okOrders + ')');
  console.log('  items:     ' + ic.n + '  (loaded: ' + okItems + ')');
  console.log('  customers: ' + cc.n);

  if (failures.length) {
    console.log('\n⚠️  ' + failures.length + ' orders failed:');
    failures.slice(0, 20).forEach((f) => console.log('   - ' + f.orderCode + ': ' + f.error));
  }

  const productsOk = Number(pc.n) === catalogSheet.products.length;
  const ordersOk = Number(oc.n) === okOrders && failures.length === 0;
  console.log(
    '\nRESULT: ' +
      (productsOk && ordersOk ? '✅ backfill complete and counts match' : '⚠️ backfill finished with mismatches — review above'),
  );
}

main()
  .then(() => {
    clearTimeout(timeout);
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nRESULT: ❌ ' + (err.message || err));
    process.exit(1);
  });
