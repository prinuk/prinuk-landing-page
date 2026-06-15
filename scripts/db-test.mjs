// End-to-end integration test for the Postgres repository (lib/store.js).
// Run in YOUR terminal (the assistant's sandbox can't reach the DB):
//   npm run db:test
//
// It creates a temporary product + order, exercises the full lifecycle
// (create → read → edit → dashboard → claim → collect), asserts the results,
// then cleans everything up. It does NOT touch any real catalog/order data.
import { eq } from 'drizzle-orm';
import storePkg from '../lib/store.js';
import clientPkg from '../lib/db/client.js';

const store = storePkg;
const { db, schema } = clientPkg;

setTimeout(() => {
  console.error('TIMEOUT after 25s — could not complete (DB unreachable?)');
  process.exit(2);
}, 25000);

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  passed += 1;
  console.log('  ✓ ' + msg);
}

const stamp = Date.now();
const productName = 'בדיקה אוטומטית ' + stamp;
const phone = '0500000001';
let orderCode = null;

async function cleanup() {
  try {
    if (orderCode) await db.delete(schema.orders).where(eq(schema.orders.orderCode, orderCode));
    await db.delete(schema.products).where(eq(schema.products.name, productName));
    await db.delete(schema.customers).where(eq(schema.customers.phone, phone));
  } catch (e) {
    console.error('cleanup warning:', e.message);
  }
}

function buildPayload(quantity) {
  return {
    customer: { fullName: 'לקוח בדיקה', phone, email: 'test@example.com' },
    fulfillment: 'איסוף עצמי',
    delivery: {},
    notes: 'בדיקה',
    items: [{ id: TEST_PRODUCT_ID, quantity }],
  };
}

let TEST_PRODUCT_ID = null;

async function main() {
  console.log('1) create a temporary product');
  await store.addProduct({
    name: productName,
    department: 'ירקות',
    unit: 'יחידות',
    priceUnit: 'יחידות',
    price: 12.5,
    state: 'active',
  });

  console.log('2) readCatalog finds it with the right shape');
  const catalog = await store.readCatalog();
  const product = catalog.products.find((p) => p.name === productName);
  assert(product, 'product appears in catalog');
  assert(product.price === 12.5, 'price round-trips as 12.5 shekels (from agorot)');
  assert(product.priceUnit === 'יחידות', 'priceUnit preserved');
  TEST_PRODUCT_ID = product.id;

  console.log('3) build + write an order (qty 2)');
  const order = store.validateAndBuildOrder(buildPayload(2), catalog.products);
  order.settings = catalog.settings;
  assert(order.estimatedTotal === 25, 'estimatedTotal = 25 (2 × 12.5)');
  const editToken = order.editToken;
  orderCode = order.orderId;
  const writeRes = await store.writeOrder(order);
  assert(writeRes.timestamp, 'writeOrder returns a timestamp');

  console.log('4) readOrderForEdit returns the order (status חדש)');
  const edit = await store.readOrderForEdit(orderCode, editToken);
  assert(edit.ok === true, 'edit allowed while חדש');
  assert(edit.order.items.length === 1, 'one item');
  assert(Number(edit.order.items[0].quantity) === 2, 'quantity is 2');
  const badEdit = await store.readOrderForEdit(orderCode, 'wrong-token');
  assert(badEdit.ok === false && badEdit.reason === 'token', 'wrong token rejected');

  console.log('5) updateOrderInPlace changes qty to 3');
  const order2 = store.validateAndBuildOrder(buildPayload(3), catalog.products);
  order2.orderId = orderCode;
  order2.settings = catalog.settings;
  await store.updateOrderInPlace(order2, editToken);

  console.log('6) dashboard detail reflects the update');
  const detail = await store.readOrderForDashboard(orderCode);
  assert(detail.ok === true, 'dashboard finds the order');
  assert(detail.order.grandTotal === 37.5, 'grandTotal now 37.5 (3 × 12.5)');
  assert(Number(detail.order.items[0].quantity) === 3, 'quantity updated to 3');

  console.log('7) order appears in the dashboard list');
  const list = await store.listOrdersForDashboard();
  const inList = list.find((o) => o.orderId === orderCode);
  assert(inList, 'order in list');
  assert(inList.itemCount === 1, 'itemCount is 1');
  assert(inList.status === 'חדש', 'status is חדש before claim');

  console.log('8) claim → בליקוט, then edit is locked');
  const claim = await store.claimOrderForPicking(orderCode, 'בודק');
  assert(claim.claimed === true && claim.status === 'בליקוט', 'claimed for picking');
  const lockedEdit = await store.readOrderForEdit(orderCode, editToken);
  assert(lockedEdit.ok === false && lockedEdit.reason === 'locked', 'edit locked after claim');

  console.log('9) collect (item picked) → נאסף');
  const collect = await store.updateOrderCollection(orderCode, {
    member: 'בודק',
    items: [{ name: productName, picked: true }],
    closeMissing: true,
  });
  assert(collect.status === 'נאסף', 'fully collected → נאסף');

  console.log('10) collect with a missing item → נאסף חלקית');
  const partial = await store.updateOrderCollection(orderCode, {
    member: 'בודק',
    items: [{ name: productName, picked: false }],
    closeMissing: true,
  });
  assert(partial.status === 'נאסף חלקית', 'missing item → נאסף חלקית');

  console.log('\nRESULT: ✅ all ' + passed + ' assertions passed');
}

main()
  .then(cleanup)
  .then(() => {
    console.log('cleanup done');
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nRESULT: ❌ ' + (err.message || err));
    await cleanup();
    process.exit(1);
  });
