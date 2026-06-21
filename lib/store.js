/**
 * Postgres repository — the database-backed equivalent of lib/sheets.js.
 *
 * Exports the SAME function names/signatures the API layer already consumes,
 * so the cutover is just swapping `require('../lib/sheets')` →
 * `require('../lib/store')` in api/*.js (catalog management is the one place
 * that changes: it keys products by uuid `id` instead of a sheet `rowNumber`).
 *
 * Pure logic (validation, pricing, formatting) is reused from lib/sheets.js —
 * not duplicated. This file only handles persistence.
 *
 * CommonJS for Stage 1 to match the existing runtime; full TypeScript lands in
 * the Stage 6 framework migration.
 */
const { eq, ne, inArray, count, and, gte, lte, max } = require('drizzle-orm');
const { db, schema } = require('./db/client');
const {
  validateAndBuildOrder,
  buildOrderChanges,
  groupProducts,
  getUnitType,
  applyUnitDeal,
  getEstimatedUnitWeightKg,
  getProductImageUrl,
  formatPrice,
  normalizeDepartment,
  normalizeProductName,
  formatEstimatedTotal,
  buildAddressText,
  normalizeCustomerPhone,
  FREE_DELIVERY_THRESHOLD,
  DELIVERY_FEE,
  defaultSettings,
  CATEGORY_ORDER,
  VERCEL_IN_PROGRESS_STATUS,
  ORDER_STATUS_NEW,
  ORDER_STATUS_PICKING,
  ORDER_STATUS_COLLECTED,
  ORDER_STATUS_PARTIAL,
  ORDER_STATUS_SENT,
  ORDER_STATUS_HANDED,
} = require('./sheets');

const {
  settings: settingsT,
  products: productsT,
  customers: customersT,
  orders: ordersT,
  orderItems: orderItemsT,
  payments: paymentsT,
  transactions: transactionsT,
} = schema;

const { PROVIDER: PAYMENT_PROVIDER } = require('./payments');

const ITEM_PICK_COLLECTED = 'נאסף';
const ITEM_PICK_MISSING = 'חסר';

// --- small helpers ---

function toAgorot(value) {
  return Math.round(Number(value || 0) * 100);
}
function fromAgorot(value) {
  return value == null ? '' : value / 100;
}
function numOrNull(value) {
  return value == null ? null : Number(value);
}
function toIso(value) {
  return value instanceof Date ? value.toISOString() : String(value || '');
}
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function initialCustomerEmailStatus(order) {
  return order.email ? VERCEL_IN_PROGRESS_STATUS : 'לא נמסר מייל';
}
function initialBusinessEmailStatus(order) {
  return order.settings && order.settings.notificationEmails
    ? VERCEL_IN_PROGRESS_STATUS
    : 'לא הוגדר מייל';
}
function initialTelegramStatus(order) {
  return order.settings && order.settings.telegramBotToken && order.settings.telegramChatId
    ? VERCEL_IN_PROGRESS_STATUS
    : 'לא הוגדר טלגרם';
}

function normalizeStatusResult(result) {
  return {
    status: String((result && result.status) || ''),
    error: String((result && result.error) || '').slice(0, 2000),
  };
}

// --- catalog (customer-facing) ---

function mapCatalogProduct(p) {
  const price = p.priceAgorot / 100;
  const columnWeight = p.weightPerUnitKg != null ? Number(p.weightPerUnitKg) : 0;
  return {
    id: p.id,
    name: p.name,
    department: p.department,
    unit: p.unit,
    priceUnit: p.priceUnit || p.unit,
    unitType: getUnitType(p.unit),
    price,
    priceDisplay: formatPrice(price),
    dealQty: p.dealQty || null,
    dealPrice: p.dealPriceAgorot != null ? p.dealPriceAgorot / 100 : null,
    estimatedUnitWeightKg: (columnWeight > 0 ? columnWeight : getEstimatedUnitWeightKg(p.name)) || null,
    imageUrl: p.imageUrl || getProductImageUrl(p.name),
    outOfStock: p.state === 'oos',
    orderCutoff: !!p.orderCutoff,
    subcategory: p.subcategory || '',
    volumeMl: p.volumeMl != null ? p.volumeMl : null,
  };
}

// Active priced catalog (state active/oos + price>0), IGNORING the open/closed
// switch — used by the PDFs (price list / flyer / signs) so they work even when
// the customer site is closed.
async function getActiveCatalog() {
  // Sequential (not Promise.all): pipelined concurrent queries can hang on the
  // Supabase transaction pooler with a single postgres.js connection.
  const settingRows = await db.select().from(settingsT);
  const productRows = await db.select().from(productsT);

  const settings = defaultSettings();
  for (const row of settingRows) {
    if (Object.prototype.hasOwnProperty.call(settings, row.key)) settings[row.key] = row.value;
  }

  // Drop hidden + unpriced rows (out-of-stock stays visible) — mirrors parseProducts.
  const products = productRows
    .filter((p) => p.state !== 'hidden' && p.priceAgorot > 0)
    .map(mapCatalogProduct);

  return { settings, products, categories: groupProducts(products) };
}

async function readCatalog() {
  const catalog = await getActiveCatalog();
  // Explicit open/closed switch: when the sale is closed, the customer catalog
  // is empty (the order page then shows settings.closedMessage). Prices in the
  // DB are preserved — they are NOT wiped on close.
  if (catalog.settings.saleStatus === 'closed') {
    return { settings: catalog.settings, products: [], categories: [] };
  }
  return catalog;
}

// --- orders: write ---

async function upsertCustomer(tx, order) {
  const rows = await tx
    .insert(customersT)
    .values({ phone: order.phone, fullName: order.fullName, email: order.email || '' })
    .onConflictDoUpdate({
      target: customersT.phone,
      set: { fullName: order.fullName, email: order.email || '', updatedAt: new Date() },
    })
    .returning({ id: customersT.id });
  return rows[0].id;
}

async function insertItems(tx, orderId, items) {
  // Null out productIds that don't (still) exist, so a deleted catalog row can
  // never make an order insert fail on the FK.
  const ids = [...new Set(items.map((l) => l.product && l.product.id).filter(isUuid))];
  let valid = new Set();
  if (ids.length) {
    const rows = await tx.select({ id: productsT.id }).from(productsT).where(inArray(productsT.id, ids));
    valid = new Set(rows.map((r) => r.id));
  }

  const values = items.map((line, i) => {
    const pid = line.product && line.product.id;
    return {
      orderId,
      productId: valid.has(pid) ? pid : null,
      productName: line.product.name,
      department: line.product.department || '',
      mode: line.mode === 'kg' ? 'kg' : 'unit',
      quantity: String(line.quantity),
      orderUnit: line.orderUnit || '',
      unitPriceAgorot: toAgorot(line.product.price),
      priceUnit: line.product.priceUnit || line.product.unit || '',
      dealQty: line.product.dealQty || null,
      dealPriceAgorot: line.product.dealPrice != null ? toAgorot(line.product.dealPrice) : null,
      lineTotalAgorot: typeof line.lineTotal === 'number' ? toAgorot(line.lineTotal) : null,
      estimatedWeightKg: line.estimatedWeightKg != null ? String(line.estimatedWeightKg) : null,
      estimatedWeightPerUnitKg:
        line.estimatedWeightPerUnitKg != null ? String(line.estimatedWeightPerUnitKg) : null,
      isEstimatedPriceTotal: !!line.isEstimatedPriceTotal,
      isEstimatedWeightTotal: !!line.isEstimatedWeightTotal,
      note: line.note || '',
      sortOrder: i,
    };
  });

  if (values.length) await tx.insert(orderItemsT).values(values);
}

function orderRowValues(order, now) {
  return {
    orderCode: order.orderId,
    fullName: order.fullName,
    phone: order.phone,
    email: order.email || '',
    fulfillment: order.fulfillment,
    neighborhood: order.neighborhood || '',
    address: order.address || '',
    floor: order.floor || '',
    apartment: order.apartment || '',
    notes: order.notes || '',
    estimatedTotalAgorot: toAgorot(order.estimatedTotal),
    deliveryFeeAgorot: toAgorot(order.deliveryFee),
    grandTotalAgorot: toAgorot(order.grandTotal),
    unpricedItemCount: order.unpricedItemCount || 0,
    paymentMethod: order.paymentMethod === 'credit' ? 'credit' : 'cash',
    editToken: order.editToken || '',
    customerEmailStatus: initialCustomerEmailStatus(order),
    customerEmailError: '',
    businessEmailStatus: initialBusinessEmailStatus(order),
    businessEmailError: '',
    telegramStatus: initialTelegramStatus(order),
    telegramError: '',
    updatedAt: now,
  };
}

async function currentSaleName() {
  const rows = await db
    .select({ value: settingsT.value })
    .from(settingsT)
    .where(eq(settingsT.key, 'saleName'))
    .limit(1);
  return rows[0] ? rows[0].value : '';
}

async function writeOrder(order) {
  const now = new Date();
  const saleName = await currentSaleName(); // stamp the order with its sale
  const pay = order.payment;
  await db.transaction(async (tx) => {
    const customerId = await upsertCustomer(tx, order);
    const [o] = await tx
      .insert(ordersT)
      .values({
        ...orderRowValues(order, now),
        saleName,
        customerId,
        status: ORDER_STATUS_NEW,
        createdAt: now,
        // card-on-file saved = ready to charge the final amount at picking.
        paymentStatus: pay ? 'authorized' : 'none',
      })
      .returning({ id: ordersT.id });
    await insertItems(tx, o.id, order.items);
    if (pay) {
      await tx.insert(paymentsT).values({
        orderId: o.id,
        provider: PAYMENT_PROVIDER,
        method: 'credit',
        status: 'authorized',
        providerCustomerRef: pay.providerCustomerRef || null,
        createdAt: now,
        updatedAt: now,
      });
      if (pay.providerCustomerRef && customerId) {
        await tx.update(customersT)
          .set({ providerCustomerRef: pay.providerCustomerRef, updatedAt: now })
          .where(eq(customersT.id, customerId));
      }
    }
  });
  // rowNumber is a sheet concept; the DB looks orders up by orderCode.
  return { rowNumber: null, timestamp: now.toISOString() };
}

// --- orders: read for customer edit ---

async function getOrderByCode(orderCode) {
  const rows = await db.select().from(ordersT).where(eq(ordersT.orderCode, orderCode)).limit(1);
  return rows[0] || null;
}

async function getItems(orderUuid) {
  const rows = await db.select().from(orderItemsT).where(eq(orderItemsT.orderId, orderUuid));
  rows.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  return rows;
}

// Split a stored "neighborhood, street" address back into parts for edit prefill.
function splitDelivery(o) {
  let neighborhood = o.neighborhood || '';
  let address = o.address || '';
  if (o.fulfillment === 'משלוח') {
    if (neighborhood && address.indexOf(neighborhood + ',') === 0) {
      address = address.slice((neighborhood + ',').length).trim();
    } else if (!neighborhood && address.indexOf(',') !== -1) {
      neighborhood = address.slice(0, address.indexOf(',')).trim();
      address = address.slice(address.indexOf(',') + 1).trim();
    }
  }
  return { neighborhood, address };
}

async function readOrderForEdit(orderId, editToken) {
  const o = await getOrderByCode(orderId);
  if (!o) return { ok: false, reason: 'notfound' };
  if (!o.editToken || o.editToken !== String(editToken || '').trim()) return { ok: false, reason: 'token' };
  if (o.status !== ORDER_STATUS_NEW) return { ok: false, reason: 'locked' };

  const items = await getItems(o.id);
  const { neighborhood, address } = splitDelivery(o);

  return {
    ok: true,
    order: {
      orderId,
      customer: { fullName: o.fullName, phone: o.phone, email: o.email },
      fulfillment: o.fulfillment,
      delivery: { neighborhood, address, floor: o.floor, apartment: o.apartment },
      notes: o.notes,
      items: items.map((it) => ({
        name: it.productName,
        department: it.department,
        mode: it.mode,
        quantity: Number(it.quantity),
        orderUnit: it.orderUnit,
        lineTotal: fromAgorot(it.lineTotalAgorot),
        note: it.note,
        pickStatus: it.pickStatus || '',
      })),
    },
  };
}

// Build the array shape buildOrderChanges() reads (sheet row indices) from a DB order.
function shimRow(o) {
  const r = [];
  r[3] = o.fullName;
  r[4] = o.phone;
  r[5] = o.fulfillment;
  r[6] = o.address;
  r[7] = o.floor;
  r[8] = o.apartment;
  r[9] = o.notes;
  r[14] = o.email;
  return r;
}

async function updateOrderInPlace(order, editToken) {
  const existing = await getOrderByCode(order.orderId);
  if (!existing) throw new Error('ההזמנה לא נמצאה. ייתכן שכבר נסגרה.');
  if (!existing.editToken || existing.editToken !== String(editToken || '').trim()) {
    throw new Error('הקישור לעריכת ההזמנה אינו תקין.');
  }
  if (existing.status !== ORDER_STATUS_NEW) {
    throw new Error('לא ניתן לעדכן את ההזמנה כי היא כבר בטיפול. אפשר ליצור קשר ונשמח לעזור.');
  }

  order.editToken = existing.editToken;

  const previousItems = await getItems(existing.id);
  order.changes = buildOrderChanges(
    previousItems.map((it) => ({ name: it.productName, quantity: Number(it.quantity), note: it.note })),
    shimRow(existing),
    order,
  );

  const now = new Date();
  await db.transaction(async (tx) => {
    const customerId = await upsertCustomer(tx, order);
    await tx
      .update(ordersT)
      .set({ ...orderRowValues(order, now), customerId })
      .where(eq(ordersT.id, existing.id));
    await tx.delete(orderItemsT).where(eq(orderItemsT.orderId, existing.id));
    await insertItems(tx, existing.id, order.items);
  });

  return { rowNumber: null, timestamp: now.toISOString() };
}

async function updateOrderNotificationStatuses(orderId, _rowNumber, results) {
  const customer = normalizeStatusResult(results && results.customerEmail);
  const business = normalizeStatusResult(results && results.businessEmail);
  const telegram = normalizeStatusResult(results && results.telegram);

  await db
    .update(ordersT)
    .set({
      customerEmailStatus: customer.status,
      customerEmailError: customer.error,
      businessEmailStatus: business.status,
      businessEmailError: business.error,
      telegramStatus: telegram.status,
      telegramError: telegram.error,
      updatedAt: new Date(),
    })
    .where(eq(ordersT.orderCode, orderId));
}

// No separate picking sheet in the DB world — the dashboard reads order_items
// directly. Kept as a no-op so api/order.js stays unchanged.
async function appendPickingOrder() {
  return { skipped: true };
}

// --- team dashboard ---

function mapSummary(o, itemCount) {
  return {
    orderId: o.orderCode,
    timestamp: toIso(o.createdAt),
    fullName: o.fullName,
    phone: o.phone,
    fulfillment: o.fulfillment,
    address: o.address,
    floor: o.floor,
    apartment: o.apartment,
    notes: o.notes,
    saleName: o.saleName || '',
    itemCount,
    status: o.status,
    grandTotal: fromAgorot(o.grandTotalAgorot),
    actualTotal: fromAgorot(o.actualTotalAgorot),
    unpricedItemCount: o.unpricedItemCount || 0,
    email: o.email,
    updatedAt: o.updatedAt ? toIso(o.updatedAt) : '',
    collectedBy: o.collectedBy || '',
    pickedAt: o.pickedAt ? toIso(o.pickedAt) : '',
  };
}

// Scope: {} or {saleName} → that sale (default = current sale);
// {from,to} → createdAt date range; {all:true} → every order.
// Cancelled orders (מבוטל) are always excluded (hidden from lists + reports).
function buildOrderScopeWhere(scope, resolvedSaleName) {
  const notCancelled = ne(ordersT.status, 'מבוטל');
  if (scope && scope.all) return notCancelled;
  if (scope && (scope.from || scope.to)) {
    const conds = [notCancelled];
    if (scope.from) conds.push(gte(ordersT.createdAt, new Date(scope.from)));
    if (scope.to) {
      const to = /^\d{4}-\d{2}-\d{2}$/.test(scope.to) ? new Date(scope.to + 'T23:59:59.999') : new Date(scope.to);
      conds.push(lte(ordersT.createdAt, to));
    }
    return and(...conds);
  }
  return and(notCancelled, eq(ordersT.saleName, resolvedSaleName));
}

async function listOrdersForDashboard(scope = {}) {
  const usesSale = !(scope && (scope.all || scope.from || scope.to));
  const resolvedSaleName = usesSale
    ? (scope && scope.saleName != null && scope.saleName !== '' ? scope.saleName : await currentSaleName())
    : '';
  const where = buildOrderScopeWhere(scope, resolvedSaleName);

  // Sequential (see readCatalog note on the pooler + concurrent queries).
  const rows = where ? await db.select().from(ordersT).where(where) : await db.select().from(ordersT);

  let countMap = new Map();
  const ids = rows.map((o) => o.id);
  if (ids.length) {
    const counts = await db
      .select({ orderId: orderItemsT.orderId, n: count() })
      .from(orderItemsT)
      .where(inArray(orderItemsT.orderId, ids))
      .groupBy(orderItemsT.orderId);
    countMap = new Map(counts.map((c) => [c.orderId, Number(c.n)]));
  }

  const orders = rows.map((o) => mapSummary(o, countMap.get(o.id) || 0));
  orders.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return orders;
}

// Per-product purchasing summary for a scope (default = current sale): how many
// units were ordered and the estimated kg to buy for weight-priced items.
// Replaces the Apps Script "סיכום משקל ויחידות".
async function getWeightSummary(scope = {}) {
  const usesSale = !(scope && (scope.all || scope.from || scope.to));
  const resolvedSaleName = usesSale
    ? (scope && scope.saleName != null && scope.saleName !== '' ? scope.saleName : await currentSaleName())
    : '';
  const where = buildOrderScopeWhere(scope, resolvedSaleName);

  const orderRows = where
    ? await db.select({ id: ordersT.id }).from(ordersT).where(where)
    : await db.select({ id: ordersT.id }).from(ordersT);
  const ids = orderRows.map((o) => o.id);
  if (!ids.length) return { saleName: resolvedSaleName, orderCount: 0, items: [] };

  const items = await db.select().from(orderItemsT).where(inArray(orderItemsT.orderId, ids));

  const map = new Map();
  for (const it of items) {
    const key = normalizeProductName(it.productName);
    let row = map.get(key);
    if (!row) {
      row = {
        name: it.productName,
        department: it.department || '',
        priceUnit: it.priceUnit || '',
        weightPriced: getUnitType(it.priceUnit) === 'kg',
        totalUnits: 0,
        estWeightKg: 0,
        needsManualWeight: false,
      };
      map.set(key, row);
    }
    row.totalUnits += Number(it.quantity) || 0;
    if (it.estimatedWeightKg != null) row.estWeightKg += Number(it.estimatedWeightKg);
    else if (it.mode === 'kg') row.estWeightKg += Number(it.quantity) || 0;
    else if (row.weightPriced) row.needsManualWeight = true;
  }

  const result = [...map.values()]
    .map((r) => ({
      name: r.name,
      department: r.department,
      priceUnit: r.priceUnit,
      totalUnits: Math.round(r.totalUnits * 1000) / 1000,
      estWeightKg: r.weightPriced ? Math.round(r.estWeightKg * 1000) / 1000 : null,
      needsManualWeight: r.needsManualWeight,
    }))
    .sort((a, b) => (a.department || '').localeCompare(b.department || '', 'he') || a.name.localeCompare(b.name, 'he'));

  return { saleName: resolvedSaleName, orderCount: ids.length, items: result };
}

// Distinct sales seen in orders (for the dashboard's sale selector), newest first.
async function getSalesList() {
  const rows = await db
    .select({ saleName: ordersT.saleName, n: count(), last: max(ordersT.createdAt) })
    .from(ordersT)
    .groupBy(ordersT.saleName);
  return rows
    .filter((r) => r.saleName)
    .map((r) => ({ saleName: r.saleName, count: Number(r.n), lastAt: r.last ? toIso(r.last) : '' }))
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

async function readOrderForDashboard(orderId) {
  const o = await getOrderByCode(orderId);
  if (!o) return { ok: false, reason: 'notfound' };

  const items = await getItems(o.id);
  const summary = mapSummary(o, items.length);
  const addressText = buildAddressText({
    fulfillment: o.fulfillment,
    address: o.address,
    floor: o.floor,
    apartment: o.apartment,
  });
  const totalText = formatEstimatedTotal(
    typeof summary.grandTotal === 'number' ? summary.grandTotal : 0,
    summary.unpricedItemCount,
    0, // grandTotal already includes any delivery fee
  );

  return {
    ok: true,
    order: {
      ...summary,
      addressText,
      totalText,
      items: items.map((it) => ({
        id: it.id,
        name: it.productName,
        department: it.department,
        quantity: Number(it.quantity),
        orderUnit: it.orderUnit,
        priceUnit: it.priceUnit,
        unitPrice: (it.unitPriceAgorot || 0) / 100, // price per priceUnit (per kg for kg items)
        isWeightPriced: getUnitType(it.priceUnit) === 'kg',
        dealQty: it.dealQty || null,
        dealPrice: it.dealPriceAgorot != null ? it.dealPriceAgorot / 100 : null,
        lineTotal: fromAgorot(it.lineTotalAgorot),
        actualWeightKg: it.actualWeightKg == null ? null : Number(it.actualWeightKg),
        actualQuantity: it.actualQuantity == null ? null : Number(it.actualQuantity),
        actualLineTotal: fromAgorot(it.actualLineTotalAgorot),
        note: it.note,
        picked: it.pickStatus === ITEM_PICK_COLLECTED,
        pickStatus: it.pickStatus || '',
      })),
    },
  };
}

// Full orders (with items) for printing. Either { codes: [orderCode,...] } for an
// explicit selection, or { scope } (default current sale). Cancelled excluded
// for scope; explicit codes are honored as-is.
async function getOrdersDetailed({ scope, codes } = {}) {
  let rows;
  if (codes && codes.length) {
    rows = await db.select().from(ordersT).where(inArray(ordersT.orderCode, codes));
  } else {
    const usesSale = !(scope && (scope.all || scope.from || scope.to));
    const resolved = usesSale
      ? (scope && scope.saleName != null && scope.saleName !== '' ? scope.saleName : await currentSaleName())
      : '';
    rows = await db.select().from(ordersT).where(buildOrderScopeWhere(scope || {}, resolved));
  }
  rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const result = [];
  for (const o of rows) {
    const items = await getItems(o.id);
    const summary = mapSummary(o, items.length);
    result.push({
      ...summary,
      addressText: buildAddressText({ fulfillment: o.fulfillment, address: o.address, floor: o.floor, apartment: o.apartment }),
      totalText: formatEstimatedTotal(typeof summary.grandTotal === 'number' ? summary.grandTotal : 0, summary.unpricedItemCount, 0),
      items: items.map((it) => ({
        name: it.productName,
        department: it.department,
        quantity: Number(it.quantity),
        orderUnit: it.orderUnit,
        lineTotal: fromAgorot(it.lineTotalAgorot),
        isWeightPriced: getUnitType(it.priceUnit) === 'kg',
        actualWeightKg: it.actualWeightKg == null ? null : Number(it.actualWeightKg),
        actualQuantity: it.actualQuantity == null ? null : Number(it.actualQuantity),
        actualLineTotal: fromAgorot(it.actualLineTotalAgorot),
        pickStatus: it.pickStatus || '',
        note: it.note,
      })),
    });
  }
  return result;
}

async function claimOrderForPicking(orderId, member) {
  const o = await getOrderByCode(orderId);
  if (!o) return { ok: false, reason: 'notfound' };
  if (o.status !== ORDER_STATUS_NEW) return { ok: true, status: o.status, claimed: false };

  await db
    .update(ordersT)
    .set({ status: ORDER_STATUS_PICKING, collectedBy: String(member || '').trim(), updatedAt: new Date() })
    .where(eq(ordersT.id, o.id));

  return { ok: true, status: ORDER_STATUS_PICKING, claimed: true };
}

async function updateOrderCollection(orderId, { member, items, closeMissing } = {}) {
  const o = await getOrderByCode(orderId);
  if (!o) return { ok: false, reason: 'notfound' };

  const byName = {};
  (items || []).forEach((it) => {
    byName[normalizeProductName(it.name)] = it;
  });

  const existing = await getItems(o.id);
  let anyMissing = false;
  existing.forEach((it) => {
    const inp = byName[normalizeProductName(it.productName)];
    const picked = inp ? inp.picked !== false : true;
    if (!picked) anyMissing = true;
  });

  const keepOpen = anyMissing && closeMissing === false;
  const status = keepOpen
    ? ORDER_STATUS_PICKING
    : anyMissing
      ? ORDER_STATUS_PARTIAL
      : ORDER_STATUS_COLLECTED;
  const now = new Date();
  let actualTotalAgorot = 0; // final weighed total (collected items only)

  await db.transaction(async (tx) => {
    for (const it of existing) {
      const inp = byName[normalizeProductName(it.productName)];
      const picked = inp ? inp.picked !== false : true;
      const set = { pickStatus: picked ? ITEM_PICK_COLLECTED : keepOpen ? null : ITEM_PICK_MISSING };

      if (picked) {
        const isWeight = getUnitType(it.priceUnit) === 'kg';
        if (isWeight) {
          // kg-priced: collected weight × price/kg (else the stored estimate).
          const wRaw = inp ? inp.actualWeightKg : undefined;
          const hasWeight = wRaw != null && wRaw !== '' && isFinite(Number(wRaw)) && Number(wRaw) > 0;
          set.actualWeightKg = hasWeight ? String(Number(wRaw)) : null;
          set.actualQuantity = null;
          set.actualLineTotalAgorot = hasWeight ? Math.round(Number(wRaw) * (it.unitPriceAgorot || 0)) : it.lineTotalAgorot;
        } else {
          // unit-priced: collected amount × unit price (honouring any "X for Y"
          // deal); defaults to the ordered qty.
          // Unit amounts are whole numbers (weights may be fractional).
          const qRaw = inp ? inp.actualQuantity : undefined;
          const q = qRaw != null && qRaw !== '' && isFinite(Number(qRaw)) && Number(qRaw) >= 0 ? Math.round(Number(qRaw)) : Number(it.quantity);
          set.actualQuantity = String(q);
          set.actualWeightKg = null;
          set.actualLineTotalAgorot = it.unitPriceAgorot
            ? Math.round(applyUnitDeal(q, it.unitPriceAgorot, it.dealQty, it.dealPriceAgorot))
            : it.lineTotalAgorot;
        }
        if (set.actualLineTotalAgorot != null) actualTotalAgorot += set.actualLineTotalAgorot;
      } else {
        set.actualWeightKg = null;
        set.actualQuantity = null;
        set.actualLineTotalAgorot = null;
      }

      await tx.update(orderItemsT).set(set).where(eq(orderItemsT.id, it.id));
    }
    await tx
      .update(ordersT)
      .set({ status, collectedBy: String(member || '').trim(), pickedAt: now, actualTotalAgorot, updatedAt: now })
      .where(eq(ordersT.id, o.id));
  });

  return { ok: true, status, pickedAt: now.toISOString(), collectedBy: String(member || '').trim(), actualTotal: actualTotalAgorot / 100 };
}

async function setOrderStatus(orderId, status, member) {
  const o = await getOrderByCode(orderId);
  if (!o) return { ok: false, reason: 'notfound' };

  const set = { status, updatedAt: new Date() };
  let collectedBy;

  if (status === ORDER_STATUS_NEW) {
    set.collectedBy = '';
    set.pickedAt = null;
    collectedBy = '';
  } else if (status === ORDER_STATUS_PICKING && String(member || '').trim()) {
    collectedBy = String(member).trim();
    set.collectedBy = collectedBy;
  }

  await db.update(ordersT).set(set).where(eq(ordersT.id, o.id));
  return { ok: true, status, collectedBy };
}

// Recompute a single item's line total + estimated weight for a new quantity,
// using the pricing snapshot stored on the item (no catalog lookup needed).
function recomputeLine(item, qty) {
  const isWeight = getUnitType(item.priceUnit) === 'kg';
  const unitPrice = item.unitPriceAgorot || 0;
  if (item.lineTotalAgorot == null && !unitPrice) {
    return { lineTotalAgorot: null, estimatedWeightKg: item.estimatedWeightKg };
  }
  if (isWeight && item.estimatedWeightPerUnitKg != null) {
    const estWeightKg = Math.round(qty * Number(item.estimatedWeightPerUnitKg) * 1000) / 1000;
    return { lineTotalAgorot: Math.round(estWeightKg * unitPrice), estimatedWeightKg: String(estWeightKg) };
  }
  if (isWeight && item.mode === 'kg') {
    return { lineTotalAgorot: Math.round(qty * unitPrice), estimatedWeightKg: String(qty) };
  }
  if (!isWeight) {
    return { lineTotalAgorot: Math.round(qty * unitPrice), estimatedWeightKg: null };
  }
  return { lineTotalAgorot: null, estimatedWeightKg: null };
}

// Team edit of an order: change customer details + item quantities / remove
// items (no adding products), recompute totals. Keeps status/saleName/createdAt.
// payload: { fullName, phone, email, fulfillment, address, floor, apartment,
//            notes, items: [{ id, quantity }] } (only kept items; qty 0 = remove)
async function adminUpdateOrder(orderCode, payload = {}) {
  const o = await getOrderByCode(orderCode);
  if (!o) throw new Error('ההזמנה לא נמצאה.');

  const existing = await getItems(o.id);
  const keepMap = new Map();
  (payload.items || []).forEach((it) => keepMap.set(String(it.id), Number(it.quantity)));

  let estimatedTotalAgorot = 0;
  let unpricedItemCount = 0;
  const updates = [];
  const removeIds = [];
  for (const item of existing) {
    const qty = keepMap.get(String(item.id));
    if (!(qty > 0)) { removeIds.push(item.id); continue; }
    const line = recomputeLine(item, qty);
    if (line.lineTotalAgorot != null) estimatedTotalAgorot += line.lineTotalAgorot;
    else unpricedItemCount += 1;
    updates.push({ id: item.id, quantity: String(qty), ...line });
  }
  if (!updates.length) throw new Error('לא ניתן להשאיר הזמנה ללא מוצרים. לביטול ההזמנה השתמשו בכפתור הביטול.');

  const fulfillment = payload.fulfillment || o.fulfillment;
  const deliveryFeeAgorot =
    fulfillment === 'משלוח' && estimatedTotalAgorot < FREE_DELIVERY_THRESHOLD * 100 ? DELIVERY_FEE * 100 : 0;
  const grandTotalAgorot = estimatedTotalAgorot + deliveryFeeAgorot;
  const now = new Date();
  const pick = (v, fallback) => (v != null ? String(v).trim() : fallback);

  await db.transaction(async (tx) => {
    await tx
      .update(ordersT)
      .set({
        fullName: pick(payload.fullName, o.fullName),
        phone: normalizeCustomerPhone(pick(payload.phone, o.phone)) || o.phone,
        email: pick(payload.email, o.email),
        fulfillment,
        address: pick(payload.address, o.address),
        floor: pick(payload.floor, o.floor),
        apartment: pick(payload.apartment, o.apartment),
        notes: pick(payload.notes, o.notes),
        estimatedTotalAgorot,
        deliveryFeeAgorot,
        grandTotalAgorot,
        unpricedItemCount,
        updatedAt: now,
      })
      .where(eq(ordersT.id, o.id));
    if (removeIds.length) await tx.delete(orderItemsT).where(inArray(orderItemsT.id, removeIds));
    for (const u of updates) {
      await tx
        .update(orderItemsT)
        .set({ quantity: u.quantity, lineTotalAgorot: u.lineTotalAgorot, estimatedWeightKg: u.estimatedWeightKg })
        .where(eq(orderItemsT.id, u.id));
    }
  });

  return { ok: true, grandTotal: grandTotalAgorot / 100, itemCount: updates.length };
}

// --- catalog management (team dashboard) ---
// NOTE: keyed by uuid `id` (not the sheet `rowNumber`). The cutover updates
// api/dashboard.js + team/index.html to pass `id` accordingly.

async function readCatalogSheet() {
  const rows = await db.select().from(productsT);
  const products = rows.map((p) => ({
    id: p.id,
    name: p.name,
    department: p.department,
    unit: p.unit,
    priceUnit: p.priceUnit,
    price: p.priceAgorot / 100,
    dealQty: p.dealQty != null ? p.dealQty : '',
    dealPrice: p.dealPriceAgorot != null ? p.dealPriceAgorot / 100 : '',
    state: p.state,
    orderCutoff: !!p.orderCutoff,
    subcategory: p.subcategory || '',
    volumeMl: p.volumeMl != null ? p.volumeMl : '',
    weightPerUnitKg: p.weightPerUnitKg != null ? Number(p.weightPerUnitKg) : '',
    autoWeightKg: getEstimatedUnitWeightKg(p.name) || '',
    image: p.imageUrl || '',
    imageUrl: p.imageUrl || getProductImageUrl(p.name),
  }));
  products.sort((a, b) => a.name.localeCompare(b.name, 'he'));
  return { products, departments: CATEGORY_ORDER.slice() };
}

async function addProduct(product) {
  const unit = String(product.unit || '').trim() || 'יחידות';
  await db.insert(productsT).values({
    name: String(product.name || '').trim(),
    department: normalizeDepartment(product.department),
    unit,
    priceUnit: String(product.priceUnit || '').trim() || unit,
    priceAgorot: toAgorot(product.price),
    dealQty: parseDealQty(product.dealQty),
    dealPriceAgorot: parseDealPrice(product.dealPrice),
    orderCutoff: !!product.orderCutoff,
    subcategory: String(product.subcategory || '').trim(),
    volumeMl: parseVolumeMl(product.volumeMl),
    state: product.state || 'active',
    weightPerUnitKg:
      product.weightPerUnitKg === '' || product.weightPerUnitKg == null
        ? null
        : String(product.weightPerUnitKg),
    imageUrl: String(product.imageUrl || '').trim(),
  });
  return { ok: true };
}

// A deal is only valid with both a group size (>=2) and a group price; any blank
// clears it (null).
function parseDealQty(v) {
  if (v === '' || v == null) return null;
  const n = Math.floor(Number(v));
  return isFinite(n) && n >= 2 ? n : null;
}
function parseDealPrice(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isFinite(n) && n >= 0 ? toAgorot(n) : null;
}
function parseVolumeMl(v) {
  if (v === '' || v == null) return null;
  const n = Math.round(Number(v));
  return isFinite(n) && n > 0 ? n : null;
}

async function updateProduct(id, product) {
  const set = {};
  if (product.name !== undefined) set.name = String(product.name).trim();
  if (product.department !== undefined) set.department = normalizeDepartment(product.department);
  if (product.unit !== undefined) set.unit = String(product.unit).trim();
  if (product.priceUnit !== undefined) set.priceUnit = String(product.priceUnit).trim();
  if (product.price !== undefined) set.priceAgorot = toAgorot(product.price);
  if (product.dealQty !== undefined) set.dealQty = parseDealQty(product.dealQty);
  if (product.dealPrice !== undefined) set.dealPriceAgorot = parseDealPrice(product.dealPrice);
  if (product.orderCutoff !== undefined) set.orderCutoff = !!product.orderCutoff;
  if (product.subcategory !== undefined) set.subcategory = String(product.subcategory || '').trim();
  if (product.volumeMl !== undefined) set.volumeMl = parseVolumeMl(product.volumeMl);
  if (product.state !== undefined) set.state = product.state;
  if (product.weightPerUnitKg !== undefined) {
    set.weightPerUnitKg =
      product.weightPerUnitKg === '' || product.weightPerUnitKg == null
        ? null
        : String(product.weightPerUnitKg);
  }
  if (product.imageUrl !== undefined) set.imageUrl = String(product.imageUrl || '').trim();

  if (Object.keys(set).length) {
    set.updatedAt = new Date();
    await db.update(productsT).set(set).where(eq(productsT.id, id));
  }
  return { ok: true };
}

// Bulk status change for the product list (team dashboard multi-select). The
// "cutoff" status is active + the time-limited flag; the rest clear the flag.
async function bulkUpdateProductStatus(ids, status) {
  const map = {
    active: { state: 'active', orderCutoff: false },
    oos: { state: 'oos', orderCutoff: false },
    hidden: { state: 'hidden', orderCutoff: false },
    cutoff: { state: 'active', orderCutoff: true },
  };
  const set = map[status];
  if (!set) return { ok: false, updated: 0 };
  const clean = (Array.isArray(ids) ? ids : []).map(String).filter(isUuid);
  if (!clean.length) return { ok: true, updated: 0 };
  await db.update(productsT).set({ ...set, updatedAt: new Date() }).where(inArray(productsT.id, clean));
  return { ok: true, updated: clean.length };
}

async function deleteProduct(id) {
  await db.delete(productsT).where(eq(productsT.id, id));
  return { ok: true };
}

// --- Settings (read/write for the dashboard settings editor) ---

// Keys the dashboard is allowed to edit (guards against arbitrary writes).
const EDITABLE_SETTINGS = [
  'title', 'description', 'closedMessage', 'saleName', 'pickupText',
  'logoUrl', 'notificationEmails', 'telegramBotToken', 'telegramChatId',
  'telegramPickedChatId', 'orderCutoffDisplayTime', 'orderCutoffEnforceTime',
  'contactPhone', 'contactEmail',
];

async function getSettings() {
  const rows = await db.select().from(settingsT);
  const out = defaultSettings();
  for (const row of rows) out[row.key] = row.value;
  return out;
}

async function updateSettings(partial) {
  const entries = Object.entries(partial || {}).filter(([k]) => EDITABLE_SETTINGS.includes(k));
  if (!entries.length) return { ok: true, updated: 0 };
  await db.transaction(async (tx) => {
    for (const [key, value] of entries) {
      const v = String(value == null ? '' : value);
      await tx
        .insert(settingsT)
        .values({ key, value: v })
        .onConflictDoUpdate({ target: settingsT.key, set: { value: v, updatedAt: new Date() } });
    }
  });
  return { ok: true, updated: entries.length };
}

module.exports = {
  readCatalog,
  getActiveCatalog,
  getSettings,
  updateSettings,
  validateAndBuildOrder, // pure, re-exported for API parity
  buildOrderChanges, // pure, re-exported for API parity
  writeOrder,
  readOrderForEdit,
  updateOrderInPlace,
  appendPickingOrder,
  updateOrderNotificationStatuses,
  listOrdersForDashboard,
  getSalesList,
  getWeightSummary,
  getOrdersDetailed,
  readOrderForDashboard,
  claimOrderForPicking,
  updateOrderCollection,
  setOrderStatus,
  adminUpdateOrder,
  readCatalogSheet,
  addProduct,
  updateProduct,
  bulkUpdateProductStatus,
  deleteProduct,
  ORDER_STATUS_NEW,
  ORDER_STATUS_PICKING,
  ORDER_STATUS_COLLECTED,
  ORDER_STATUS_PARTIAL,
  ORDER_STATUS_SENT,
  ORDER_STATUS_HANDED,
};
