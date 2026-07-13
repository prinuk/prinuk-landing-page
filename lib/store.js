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
const { eq, ne, inArray, count, and, gte, lte, max, min, sum, sql } = require('drizzle-orm');
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
  resolveDelivery,
  generateOrderId,
  generateEditToken,
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

const { PROVIDER: PAYMENT_PROVIDER, getPaymentAdapter, paymentsEnabled } = require('./payments');

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
    // Estimate weight is the admin-defined per-unit weight only (no name-based map).
    estimatedUnitWeightKg: columnWeight > 0 ? columnWeight : null,
    imageUrl: p.imageUrl || getProductImageUrl(p.name),
    outOfStock: p.state === 'oos',
    orderCutoff: !!p.orderCutoff,
    subcategory: p.subcategory || '',
    volumeMl: p.volumeMl != null ? p.volumeMl : null,
    vatExempt: p.vatExempt !== false,
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
      vatExempt: line.product.vatExempt !== false,
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
        cardExpiry: pay.cardExpiry || null,
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
  // Sort by category (ירקות, פירות, עלים, מיוחדים, …) then original cart order,
  // so picking lists / order details follow the shop's category sequence.
  const catIdx = (d) => {
    const i = CATEGORY_ORDER.indexOf(normalizeDepartment(d || ''));
    return i === -1 ? CATEGORY_ORDER.length : i; // unknown departments last
  };
  rows.sort((a, b) => (catIdx(a.department) - catIdx(b.department)) || ((a.sortOrder || 0) - (b.sortOrder || 0)));
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
  const prow = (await db.select().from(paymentsT).where(eq(paymentsT.orderId, o.id)))[0];

  return {
    ok: true,
    order: {
      orderId,
      customer: { fullName: o.fullName, phone: o.phone, email: o.email },
      fulfillment: o.fulfillment,
      delivery: { neighborhood, address, floor: o.floor, apartment: o.apartment },
      notes: o.notes,
      // Payment: pre-select the method on edit, and if a card is on file the
      // customer doesn't have to re-enter it.
      paymentMethod: o.paymentMethod === 'credit' ? 'credit' : 'cash',
      hasCard: !!(prow && prow.providerCustomerRef),
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

  // Payment on edit: credit with no new card keeps the saved card (error if none);
  // a new card (order.payment) replaces it; switching to cash leaves it unused.
  const existingCard = (await db.select().from(paymentsT).where(eq(paymentsT.orderId, existing.id)))[0];
  if (order.paymentMethod === 'credit' && !order.payment) {
    if (!existingCard || !existingCard.providerCustomerRef) {
      throw new Error('חסרים פרטי אשראי לעדכון. נא להזין את פרטי הכרטיס.');
    }
  }

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
      .set({ ...orderRowValues(order, now), paymentStatus: order.paymentMethod === 'credit' ? 'authorized' : 'none', customerId })
      .where(eq(ordersT.id, existing.id));
    await tx.delete(orderItemsT).where(eq(orderItemsT.orderId, existing.id));
    await insertItems(tx, existing.id, order.items);
    // Persist a newly entered/replacement card.
    if (order.payment && order.payment.providerCustomerRef) {
      const values = {
        provider: PAYMENT_PROVIDER, method: 'credit', status: 'authorized',
        providerCustomerRef: order.payment.providerCustomerRef,
        cardExpiry: order.payment.cardExpiry || null, updatedAt: now,
      };
      if (existingCard) await tx.update(paymentsT).set(values).where(eq(paymentsT.id, existingCard.id));
      else await tx.insert(paymentsT).values({ orderId: existing.id, createdAt: now, ...values });
    }
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
    origin: o.origin || 'web',
    itemCount,
    status: o.status,
    grandTotal: fromAgorot(o.grandTotalAgorot),
    actualTotal: fromAgorot(o.actualTotalAgorot),
    // Final billed total once collected = collected items − discount + delivery
    // (null until the order is picked). grandTotal stays the order-time estimate.
    finalTotal: o.actualTotalAgorot != null
      ? fromAgorot(Math.max(0, o.actualTotalAgorot - (o.discountAgorot || 0)) + (o.deliveryFeeAgorot || 0))
      : '',
    deliveryFee: fromAgorot(o.deliveryFeeAgorot),
    discount: fromAgorot(o.discountAgorot),
    paymentMethod: o.paymentMethod || 'cash',
    paymentStatus: o.paymentStatus || 'none',
    paymentStatusManual: o.paymentStatusManual || '',
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

// Weekly orders report: one row per sale (each sale = a week), with the order
// count and estimated revenue (sum of grand totals). Cancelled orders excluded.
async function getWeeklyReport() {
  const rows = await db
    .select({
      saleName: ordersT.saleName,
      n: count(),
      revenue: sum(ordersT.grandTotalAgorot),
      // Final (collected) revenue: only orders that were picked contribute their
      // billed total = collected items − discount + delivery.
      finalRevenue: sum(sql`CASE WHEN ${ordersT.actualTotalAgorot} IS NOT NULL THEN GREATEST(0, ${ordersT.actualTotalAgorot} - COALESCE(${ordersT.discountAgorot}, 0)) + COALESCE(${ordersT.deliveryFeeAgorot}, 0) ELSE 0 END`),
      web: sum(sql`CASE WHEN ${ordersT.origin} = 'manual' THEN 0 ELSE 1 END`),
      manual: sum(sql`CASE WHEN ${ordersT.origin} = 'manual' THEN 1 ELSE 0 END`),
      // Final (collected) revenue split by origin — how much money came from each.
      webRevenue: sum(sql`CASE WHEN ${ordersT.origin} <> 'manual' AND ${ordersT.actualTotalAgorot} IS NOT NULL THEN GREATEST(0, ${ordersT.actualTotalAgorot} - COALESCE(${ordersT.discountAgorot}, 0)) + COALESCE(${ordersT.deliveryFeeAgorot}, 0) ELSE 0 END`),
      manualRevenue: sum(sql`CASE WHEN ${ordersT.origin} = 'manual' AND ${ordersT.actualTotalAgorot} IS NOT NULL THEN GREATEST(0, ${ordersT.actualTotalAgorot} - COALESCE(${ordersT.discountAgorot}, 0)) + COALESCE(${ordersT.deliveryFeeAgorot}, 0) ELSE 0 END`),
      first: min(ordersT.createdAt),
      last: max(ordersT.createdAt),
    })
    .from(ordersT)
    .where(ne(ordersT.status, 'מבוטל'))
    .groupBy(ordersT.saleName);
  return rows
    .filter((r) => r.saleName)
    .map((r) => ({
      saleName: r.saleName,
      count: Number(r.n),
      web: Number(r.web || 0),
      manual: Number(r.manual || 0),
      webRevenue: Number(r.webRevenue || 0) / 100,
      manualRevenue: Number(r.manualRevenue || 0) / 100,
      revenue: Number(r.revenue || 0) / 100,
      finalRevenue: Number(r.finalRevenue || 0) / 100,
      firstAt: r.first ? toIso(r.first) : '',
      lastAt: r.last ? toIso(r.last) : '',
    }))
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

// Per-sale order timeline for the comparison report: orders grouped by
// (day-since-sale-opened, hour-of-day) in Asia/Jerusalem, so the dashboard can
// show — chronologically — how many orders came in each hour of each day and the
// running cumulative, and compare that across sales.
const ISRAEL_HOUR_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false });
const ISRAEL_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });
function israelHourOf(d) {
  const h = parseInt(ISRAEL_HOUR_FMT.format(new Date(d)), 10);
  return Number.isNaN(h) ? 0 : (h >= 24 ? 0 : h);
}
async function getOrdersTimeline() {
  const rows = await db
    .select({ saleName: ordersT.saleName, createdAt: ordersT.createdAt })
    .from(ordersT)
    .where(ne(ordersT.status, 'מבוטל'));
  const bySale = new Map();
  for (const r of rows) {
    if (!r.saleName || !r.createdAt) continue;
    if (!bySale.has(r.saleName)) bySale.set(r.saleName, []);
    bySale.get(r.saleName).push(r.createdAt);
  }
  const result = [];
  for (const [saleName, dates] of bySale) {
    const items = dates
      .map((d) => ({ t: new Date(d).getTime(), date: ISRAEL_DATE_FMT.format(new Date(d)), hour: israelHourOf(d) }))
      .sort((a, b) => a.t - b.t);
    const dayOf = new Map();
    let dayCount = 0;
    const slotMap = new Map(); // "day|hour" -> count
    for (const it of items) {
      if (!dayOf.has(it.date)) dayOf.set(it.date, ++dayCount);
      const key = dayOf.get(it.date) + '|' + it.hour;
      slotMap.set(key, (slotMap.get(key) || 0) + 1);
    }
    const slots = [...slotMap.entries()]
      .map(([key, count]) => { const parts = key.split('|'); return { day: Number(parts[0]), hour: Number(parts[1]), count }; })
      .sort((a, b) => (a.day - b.day) || (a.hour - b.hour));
    result.push({ saleName, total: items.length, last: items[items.length - 1].t, slots });
  }
  return result.sort((a, b) => b.last - a.last).map(({ saleName, total, slots }) => ({ saleName, total, slots }));
}

// Customer export: one row per customer (grouped by phone, else email), with
// order count, first/last dates and first sale. Filters:
//   mode 'all'  → every customer
//   mode 'sale' → customers who ordered in `saleName`
//   mode 'new'  → customers whose FIRST order was in `saleName` (new that sale)
async function getCustomers({ mode, saleName } = {}) {
  const rows = await db
    .select({
      phone: ordersT.phone, fullName: ordersT.fullName, email: ordersT.email,
      saleName: ordersT.saleName, createdAt: ordersT.createdAt,
    })
    .from(ordersT)
    .where(ne(ordersT.status, 'מבוטל'));
  const byKey = new Map();
  for (const r of rows) {
    const key = String(r.phone || r.email || '').trim();
    if (!key) continue;
    const t = r.createdAt ? new Date(r.createdAt).getTime() : 0;
    let c = byKey.get(key);
    if (!c) {
      c = { phone: r.phone || '', name: r.fullName || '', email: r.email || '', orders: 0, firstSale: r.saleName || '', sales: new Set(), _first: Infinity, _last: 0, _emailAt: -1 };
      byKey.set(key, c);
    }
    c.orders += 1;
    if (r.saleName) c.sales.add(r.saleName);
    if (t && t < c._first) { c._first = t; c.firstSale = r.saleName || ''; }
    if (t && t >= c._last) { c._last = t; c.lastAt = r.createdAt; c.name = r.fullName || c.name; }
    if (r.email && t >= c._emailAt) { c._emailAt = t; c.email = r.email; }
  }
  let list = [...byKey.values()];
  if (mode === 'sale' && saleName) list = list.filter((c) => c.sales.has(saleName));
  else if (mode === 'new' && saleName) list = list.filter((c) => c.firstSale === saleName);
  list.sort((a, b) => (b._last || 0) - (a._last || 0));
  return list.map((c) => ({
    name: c.name, phone: c.phone, email: c.email, orders: c.orders,
    firstSale: c.firstSale, lastAt: c.lastAt ? toIso(c.lastAt) : '',
  }));
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

  const prow = (await db.select().from(paymentsT).where(eq(paymentsT.orderId, o.id)))[0];
  const payment = {
    method: o.paymentMethod || 'cash',
    status: (prow && prow.status) || o.paymentStatus || 'none',
    invoiceUrl: (prow && prow.invoiceUrl) || '',
    hasCard: !!(prow && prow.providerCustomerRef),
    enabled: paymentsEnabled(),
  };

  return {
    ok: true,
    order: {
      ...summary,
      addressText,
      totalText,
      payment,
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
        discount: fromAgorot(it.discountAgorot),
        note: it.note,
        picked: it.pickStatus === ITEM_PICK_COLLECTED,
        pickStatus: it.pickStatus || '',
      })),
      orderDiscount: fromAgorot(o.discountAgorot),
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
  const dRules = resolveDelivery(await getSettings());

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
    // Re-evaluate delivery against the final total: charge it ONLY when the
    // estimate AND the collected total are both below the free-delivery threshold
    // (free once either crosses it — the customer paid enough).
    const threshAg = dRules.threshold * 100;
    const deliveryFeeAgorot = (o.fulfillment === 'משלוח'
      && (o.estimatedTotalAgorot || 0) < threshAg
      && actualTotalAgorot < threshAg)
      ? dRules.fee * 100 : 0;

    await tx
      .update(ordersT)
      .set({ status, collectedBy: String(member || '').trim(), pickedAt: now, actualTotalAgorot, deliveryFeeAgorot, updatedAt: now })
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

// Charge a credit order's saved card for the final (weighed) amount and record
// the result. Idempotent: a captured order won't be charged again.
// Build the invoice/charge lines + final amount for an order from its COLLECTED
// (weighed/net) amounts − order discount + delivery. Shared by the card charge
// and the external-payment document so both bill exactly the same thing.
// Lines carry vatExempt so the document breaks out VAT on taxable lines only;
// amounts are VAT-inclusive (gross) — the processor computes the VAT portion.
async function buildOrderChargeItems(o) {
  const itemsTotalAgorot = o.actualTotalAgorot != null
    ? o.actualTotalAgorot
    : (o.grandTotalAgorot - (o.deliveryFeeAgorot || 0));
  const orderDiscount = o.discountAgorot || 0;
  const deliveryFee = o.deliveryFeeAgorot || 0;
  const amountAgorot = Math.max(0, itemsTotalAgorot - orderDiscount) + deliveryFee;

  // Only COLLECTED lines are billed — exclude missing (חסר) items, otherwise the
  // document total would exceed the charged amount and Cardcom rejects the doc
  // ("DocumentType: Error") while still charging the card.
  const items = (await getItems(o.id))
    .filter((it) => it.pickStatus !== ITEM_PICK_MISSING)
    .map((it) => {
      const isWeight = getUnitType(it.priceUnit) === 'kg';
      const wkg = it.actualWeightKg != null ? Number(it.actualWeightKg)
        : (it.estimatedWeightKg != null ? Number(it.estimatedWeightKg) : null);
      return {
        name: it.productName,
        quantity: Number(it.quantity),
        lineTotalAgorot: it.actualLineTotalAgorot != null ? it.actualLineTotalAgorot : it.lineTotalAgorot,
        vatExempt: it.vatExempt !== false,
        // For the invoice line representation: weight-priced items show kg × price/kg.
        isWeight,
        weightKg: isWeight ? wkg : null,
        unitPriceAgorot: it.unitPriceAgorot || 0, // per priceUnit (per kg for kg items)
      };
    });
  if (orderDiscount > 0) items.push({ name: 'הנחה', quantity: 1, lineTotalAgorot: -orderDiscount, vatExempt: true });
  if (deliveryFee > 0) items.push({ name: 'משלוח', quantity: 1, lineTotalAgorot: deliveryFee, vatExempt: false });
  return { items, amountAgorot };
}

async function chargeOrder(orderCode) {
  const o = await getOrderByCode(orderCode);
  if (!o) return { ok: false, reason: 'notfound' };
  if (o.paymentMethod !== 'credit') return { ok: false, reason: 'not-credit' };

  const payment = (await db.select().from(paymentsT).where(eq(paymentsT.orderId, o.id)))[0];
  if (!payment || !payment.providerCustomerRef) return { ok: false, reason: 'no-card' };
  if (o.paymentStatus === 'captured' || payment.status === 'captured') {
    return { ok: true, alreadyCharged: true, amount: (payment.capturedAmountAgorot || 0) / 100, invoiceUrl: payment.invoiceUrl || '' };
  }

  const { items, amountAgorot } = await buildOrderChargeItems(o);
  if (!(amountAgorot > 0)) return { ok: false, reason: 'no-amount' };

  const now = new Date();
  const adapterKey = 'charge:' + o.orderCode + ':' + amountAgorot; // stable → processor de-dupes
  const res = await getPaymentAdapter().charge({
    customerRef: payment.providerCustomerRef,
    cardExpiration: payment.cardExpiry || '',
    amountAgorot,
    description: 'הזמנה ' + o.orderCode,
    items,
    // Customer details so the invoice carries the buyer's name (not "לקוח").
    customer: { fullName: o.fullName, phone: o.phone, email: o.email },
    externalId: o.orderCode,
    idempotencyKey: adapterKey,
  });

  // Append-only transaction log (unique key per attempt).
  await db.insert(transactionsT).values({
    paymentId: payment.id,
    orderId: o.id,
    type: 'capture',
    status: res.ok ? 'success' : 'failed',
    amountAgorot,
    idempotencyKey: adapterKey + ':' + now.getTime(),
    providerRef: res.paymentRef || null,
    errorMessage: res.ok ? '' : (res.error || 'charge failed'),
    raw: (res && res.json) || null,
    createdAt: now,
  });

  if (!res.ok) {
    await db.update(paymentsT).set({ status: 'failed', updatedAt: now }).where(eq(paymentsT.id, payment.id));
    return { ok: false, reason: 'charge-failed', error: res.error || 'החיוב נכשל.' };
  }

  // Normally the charge issues the tax invoice inline. If it didn't (charge ok but
  // no document), issue it separately so the customer still gets an invoice.
  let invoiceUrl = res.invoiceUrl || '';
  let invoiceRef = res.invoiceRef || '';
  if (!invoiceUrl) {
    const adapter = getPaymentAdapter();
    if (typeof adapter.createDocument === 'function') {
      try {
        const doc = await adapter.createDocument({
          customer: { fullName: o.fullName, phone: o.phone, email: o.email },
          items,
          description: 'הזמנה ' + o.orderCode,
          externalId: o.orderCode,
        });
        if (doc && doc.ok) { invoiceUrl = doc.invoiceUrl || ''; invoiceRef = doc.invoiceRef || ''; }
        else if (doc) console.error('chargeOrder fallback createDocument failed:', doc.error);
      } catch (e) {
        console.error('chargeOrder fallback createDocument error:', e.message || e);
      }
    }
  }

  await db.update(paymentsT).set({
    status: 'captured',
    capturedAmountAgorot: amountAgorot,
    providerPaymentRef: res.paymentRef || null,
    invoiceRef: invoiceRef || null,
    invoiceUrl: invoiceUrl || null,
    updatedAt: now,
  }).where(eq(paymentsT.id, payment.id));
  await db.update(ordersT).set({ paymentStatus: 'captured', updatedAt: now }).where(eq(ordersT.id, o.id));

  return { ok: true, amount: amountAgorot / 100, invoiceUrl, invoiceRef };
}

// Open (or re-open, on retry) a ChargeAndCreateToken LowProfile for an existing
// order, carrying its exact amount + invoice document. The browser loads the card
// fields against it; submitting charges + issues the invoice in one hosted op.
async function createHostedChargeSession(orderCode) {
  const o = await getOrderByCode(orderCode);
  if (!o) return { ok: false, reason: 'notfound' };
  if (o.paymentMethod !== 'credit') return { ok: false, reason: 'not-credit' };
  const { items, amountAgorot } = await buildOrderChargeItems(o);
  if (!(amountAgorot > 0)) return { ok: false, reason: 'no-amount' };
  const lp = await getPaymentAdapter().createLowProfile({
    operation: 'ChargeAndCreateToken',
    amountAgorot,
    description: 'הזמנה ' + orderCode,
    returnValue: orderCode,
    customer: { fullName: o.fullName, phone: o.phone, email: o.email },
    items,
    externalId: orderCode,
  });
  if (!lp.ok || !lp.lowProfileId) return { ok: false, reason: 'lp-failed', error: lp.error || 'לא הצלחנו לפתוח את טופס התשלום.' };
  return { ok: true, lowProfileId: lp.lowProfileId, amount: amountAgorot / 100 };
}

// Finish a two-step hosted charge (createManualOrder + hostedCharge). The browser
// has submitted the card against the ChargeAndCreateToken LowProfile; resolve it,
// record the captured payment + invoice, and mark the order paid. Idempotent.
// Fallback: if the hosted op created only a token (no charge), save the card and
// charge server-side (token → charge), so a partial result still completes.
async function finalizeHostedCharge(orderCode, lowProfileId) {
  const o = await getOrderByCode(orderCode);
  if (!o) return { ok: false, reason: 'notfound' };
  if (o.paymentMethod !== 'credit') return { ok: false, reason: 'not-credit' };
  if (!lowProfileId) return { ok: false, reason: 'missing-lp' };

  const existing = (await db.select().from(paymentsT).where(eq(paymentsT.orderId, o.id)))[0];
  if (existing && existing.status === 'captured') {
    return { ok: true, alreadyCharged: true, amount: (existing.capturedAmountAgorot || 0) / 100, invoiceUrl: existing.invoiceUrl || '' };
  }

  const lp = await getPaymentAdapter().getLowProfileResult(lowProfileId);
  if (!lp.ok) return { ok: false, reason: 'lp-failed', error: lp.error || 'שגיאה באימות התשלום.' };

  const { amountAgorot } = await buildOrderChargeItems(o);
  const now = new Date();

  // The single-operation charge went through → record it as captured.
  if (lp.charged && lp.token) {
    const capturedAmount = lp.amountAgorot != null ? lp.amountAgorot : amountAgorot;
    let payId;
    const paymentSet = {
      status: 'captured', method: 'credit', provider: PAYMENT_PROVIDER,
      providerCustomerRef: lp.token, cardExpiry: lp.cardExpiry || (existing && existing.cardExpiry) || null,
      capturedAmountAgorot: capturedAmount, providerPaymentRef: lp.paymentRef || null,
      invoiceRef: lp.invoiceRef || null, invoiceUrl: lp.invoiceUrl || null, updatedAt: now,
    };
    if (existing) {
      await db.update(paymentsT).set(paymentSet).where(eq(paymentsT.id, existing.id));
      payId = existing.id;
    } else {
      const [p] = await db.insert(paymentsT).values({ orderId: o.id, createdAt: now, ...paymentSet })
        .returning({ id: paymentsT.id });
      payId = p.id;
    }
    await db.insert(transactionsT).values({
      paymentId: payId, orderId: o.id, type: 'capture', status: 'success', amountAgorot: capturedAmount,
      idempotencyKey: 'hosted:' + orderCode + ':' + now.getTime(), providerRef: lp.paymentRef || null,
      errorMessage: '', raw: lp.raw || null, createdAt: now,
    });
    await db.update(ordersT).set({ paymentStatus: 'captured', updatedAt: now }).where(eq(ordersT.id, o.id));
    return { ok: true, charged: true, amount: capturedAmount / 100, invoiceUrl: lp.invoiceUrl || '', invoiceMissing: !lp.invoiceUrl };
  }

  // Fallback: only a token came back (card not charged in the hosted op) → save it
  // and charge server-side for the exact amount, exactly like the web flow.
  if (lp.token) {
    if (existing) {
      await db.update(paymentsT).set({ status: 'authorized', method: 'credit', providerCustomerRef: lp.token, cardExpiry: lp.cardExpiry || existing.cardExpiry || null, updatedAt: now }).where(eq(paymentsT.id, existing.id));
    } else {
      await db.insert(paymentsT).values({ orderId: o.id, provider: PAYMENT_PROVIDER, method: 'credit', status: 'authorized', providerCustomerRef: lp.token, cardExpiry: lp.cardExpiry || null, createdAt: now, updatedAt: now });
    }
    const charge = await chargeOrder(orderCode);
    if (!charge.ok) return { ok: false, reason: 'charge-failed', error: charge.error || charge.reason };
    return { ok: true, charged: true, amount: charge.amount, invoiceUrl: charge.invoiceUrl || '', invoiceMissing: !charge.invoiceUrl };
  }

  return { ok: false, reason: 'no-charge', error: 'החיוב לא הושלם. נסו שוב.' };
}

// ---- Combined / split payment across one or more orders → ONE tax invoice ----
// The orders stay separate records; a single חשבונית מס קבלה covers all their
// collected lines, paid by any mix of methods (card + cash + transfer/Bit/…).

// Load payment info for a set of orders (combined items total, saved-card + paid
// state per order) to populate the collect-payment modal.
async function getOrdersPaymentInfo(orderCodes) {
  const codes = [...new Set((orderCodes || []).map((s) => String(s).trim()).filter(Boolean))];
  const out = [];
  for (const code of codes) {
    const o = await getOrderByCode(code);
    if (!o) continue;
    const { amountAgorot } = await buildOrderChargeItems(o);
    const pay = (await db.select().from(paymentsT).where(eq(paymentsT.orderId, o.id)))[0];
    out.push({
      orderCode: o.orderCode, fullName: o.fullName, phone: o.phone, email: o.email,
      amount: amountAgorot / 100, amountAgorot,
      hasCard: !!(pay && pay.providerCustomerRef),
      paid: o.paymentStatus === 'captured' || (pay && pay.status === 'captured'),
    });
  }
  const totalAgorot = out.reduce((s, x) => s + x.amountAgorot, 0);
  return { ok: true, orders: out, totalAgorot, total: totalAgorot / 100 };
}

// Open a hosted card session for the CARD PORTION of a combined/split payment.
// No document is attached (the combined invoice is issued separately and links
// this charge by its deal number).
async function openCombinedCardSession(amountAgorot, description) {
  if (!(Number(amountAgorot) > 0)) return { ok: false, reason: 'no-amount' };
  const lp = await getPaymentAdapter().createLowProfile({
    operation: 'ChargeAndCreateToken', amountAgorot: Math.round(Number(amountAgorot)),
    description: description || 'תשלום', returnValue: 'combined',
  });
  if (!lp.ok || !lp.lowProfileId) return { ok: false, reason: 'lp-failed', error: lp.error || 'לא הצלחנו לפתוח את טופס התשלום.' };
  return { ok: true, lowProfileId: lp.lowProfileId };
}

// Collect payment for one or more orders as a SINGLE invoice. `tenders` is a list
// of { method, amountAgorot, reference } that must sum to the combined total; a
// `credit` tender is charged either on a saved card (savedCardOrderCode) or via a
// hosted session already submitted (lowProfileId). Each order is then marked paid
// and linked to the one invoice — the orders themselves are NOT merged.
async function collectPayment(payload = {}) {
  const orderCodes = [...new Set((payload.orderCodes || []).map((s) => String(s).trim()).filter(Boolean))];
  if (!orderCodes.length) return { ok: false, reason: 'no-orders' };

  const orders = [];
  for (const code of orderCodes) {
    const o = await getOrderByCode(code);
    if (!o) return { ok: false, reason: 'notfound', error: 'הזמנה ' + code + ' לא נמצאה.' };
    orders.push(o);
  }
  // Refuse if any order is already paid → avoids a double charge / double invoice.
  const alreadyPaid = [];
  for (const o of orders) {
    const pay = (await db.select().from(paymentsT).where(eq(paymentsT.orderId, o.id)))[0];
    if (o.paymentStatus === 'captured' || (pay && pay.status === 'captured')) alreadyPaid.push(o.orderCode);
  }
  if (alreadyPaid.length) return { ok: false, reason: 'already-paid', error: 'ההזמנות הבאות כבר שולמו: ' + alreadyPaid.join(', ') + '. הסירו אותן מהבחירה.' };

  // Combined line items + total, plus each order's own share (for its payment row).
  let combinedItems = [];
  let totalAgorot = 0;
  const perOrder = [];
  for (const o of orders) {
    const { items, amountAgorot } = await buildOrderChargeItems(o);
    combinedItems = combinedItems.concat(items);
    totalAgorot += amountAgorot;
    perOrder.push({ order: o, amountAgorot });
  }
  if (!(totalAgorot > 0)) return { ok: false, reason: 'no-amount' };

  // Validate tenders sum to the total (allow a 1-agora rounding gap).
  const tenders = (payload.tenders || [])
    .map((t) => ({ method: String(t.method || ''), amountAgorot: Math.round(Number(t.amountAgorot) || 0), reference: String(t.reference || '') }))
    .filter((t) => t.amountAgorot > 0);
  if (!tenders.length) return { ok: false, reason: 'no-tenders' };
  const tenderSum = tenders.reduce((s, t) => s + t.amountAgorot, 0);
  if (Math.abs(tenderSum - totalAgorot) > 1) {
    return { ok: false, reason: 'tender-mismatch', error: 'סכום אמצעי התשלום (' + (tenderSum / 100) + ') אינו שווה לסה״כ (' + (totalAgorot / 100) + ').' };
  }
  if (tenders.filter((t) => t.method === 'credit').length > 1) {
    return { ok: false, reason: 'multi-credit', error: 'ניתן לחייב כרטיס אחד בלבד בעסקה. אחדו את חלק האשראי לשורה אחת.' };
  }

  const adapter = getPaymentAdapter();
  const now = new Date();
  const paymentTenders = []; // → createTaxInvoice
  let cardDealNumber = '';
  let cardPaymentRef = '';

  const creditTender = tenders.find((t) => t.method === 'credit');
  if (creditTender) {
    if (payload.lowProfileId) {
      // New card entered via hosted fields → the charge already ran; get its deal.
      const lp = await adapter.getLowProfileResult(payload.lowProfileId);
      if (!lp.ok || !lp.charged || !lp.paymentRef) return { ok: false, reason: 'card-charge-failed', error: (lp && lp.error) || 'חיוב הכרטיס נכשל.' };
      cardDealNumber = lp.paymentRef; cardPaymentRef = lp.paymentRef;
    } else if (payload.savedCardOrderCode) {
      const src = await getOrderByCode(String(payload.savedCardOrderCode).trim());
      const pay = src ? (await db.select().from(paymentsT).where(eq(paymentsT.orderId, src.id)))[0] : null;
      if (!pay || !pay.providerCustomerRef) return { ok: false, reason: 'no-saved-card', error: 'לא נמצא כרטיס שמור להזמנה שנבחרה.' };
      const charged = await adapter.chargeToken({
        customerRef: pay.providerCustomerRef, cardExpiration: pay.cardExpiry || '',
        amountAgorot: creditTender.amountAgorot,
        idempotencyKey: 'combined:' + orderCodes.join('-') + ':' + creditTender.amountAgorot,
      });
      if (!charged.ok || !charged.dealNumber) return { ok: false, reason: 'card-charge-failed', error: charged.error || 'חיוב הכרטיס נכשל.' };
      cardDealNumber = charged.dealNumber; cardPaymentRef = charged.paymentRef;
    } else {
      return { ok: false, reason: 'no-card', error: 'לא נבחר כרטיס לחיוב.' };
    }
    paymentTenders.push({ kind: 'deal', dealNumber: cardDealNumber });
  }
  // Cash + external tenders → invoice payment lines.
  tenders.forEach((t) => {
    if (t.method === 'credit') return;
    if (t.method === 'cash') { paymentTenders.push({ kind: 'cash', amountAgorot: t.amountAgorot }); return; }
    const payMethodId = typeof adapter.payMethodAccountId === 'function' ? adapter.payMethodAccountId(t.method) : null;
    if (payMethodId != null) paymentTenders.push({ kind: 'custom', payMethodId, amountAgorot: t.amountAgorot, reference: t.reference });
    else paymentTenders.push({ kind: 'cash', amountAgorot: t.amountAgorot }); // unknown method → book as cash
  });

  // Invoice recipient: chosen name/phone/email, defaulting to the first order.
  const recip = payload.recipient || {};
  const first = orders[0];
  const customer = {
    fullName: String(recip.fullName || first.fullName || 'לקוח').trim() || 'לקוח',
    phone: String(recip.phone || first.phone || '').trim(),
    email: String(recip.email || first.email || '').trim(),
  };

  const inv = await adapter.createTaxInvoice({
    customer, items: combinedItems, description: 'הזמנות ' + orderCodes.join(', '),
    externalId: orderCodes.join(','), invoiceType: 1, payments: paymentTenders, sendByEmail: false,
  });
  if (!inv.ok) {
    return { ok: false, reason: 'invoice-failed', error: inv.error || 'הפקת החשבונית נכשלה.', cardCharged: !!cardDealNumber, cardPaymentRef };
  }

  // Mark each order paid + attach the shared invoice; record a payment row per order
  // for its own share so per-order revenue reporting stays correct.
  for (const po of perOrder) {
    const o = po.order;
    const existing = (await db.select().from(paymentsT).where(eq(paymentsT.orderId, o.id)))[0];
    const set = {
      status: 'captured', invoiceRef: inv.invoiceRef || null, invoiceUrl: inv.invoiceUrl || null,
      capturedAmountAgorot: po.amountAgorot, updatedAt: now,
    };
    if (existing) await db.update(paymentsT).set(set).where(eq(paymentsT.id, existing.id));
    else await db.insert(paymentsT).values({ orderId: o.id, provider: PAYMENT_PROVIDER, method: creditTender ? 'credit' : 'cash', createdAt: now, ...set });
    await db.update(ordersT).set({ paymentStatus: 'captured', updatedAt: now }).where(eq(ordersT.id, o.id));
  }

  return { ok: true, invoiceUrl: inv.invoiceUrl || '', invoiceRef: inv.invoiceRef || '', allocationNumber: inv.allocationNumber || '', amount: totalAgorot / 100, orderCount: orders.length };
}

// Issue a חשבונית מס קבלה for an order paid OUTSIDE Cardcom — bank transfer,
// Bit, Paybox, PayPal. Bills the same collected amount as a card charge and
// records the real method via CreateTaxInvoice CustomLines (its own payment
// account, NOT cash), so the document shows "אופן התשלום: …". `method` is a
// key (transfer/bit/paybox/paypal) mapped to Cardcom's payment-account number;
// `reference` is the אסמכתה. Falls back to a plain TaxInvoice + note if the
// method/endpoint isn't available.
async function issueOrderDocument(orderCode, opts = {}) {
  const o = await getOrderByCode(orderCode);
  if (!o) return { ok: false, reason: 'notfound' };
  const adapter = getPaymentAdapter();
  const canTaxInvoice = typeof adapter.createTaxInvoice === 'function';
  if (!canTaxInvoice && typeof adapter.createDocument !== 'function') return { ok: false, reason: 'unsupported' };

  const { items, amountAgorot } = await buildOrderChargeItems(o);
  if (!(amountAgorot > 0)) return { ok: false, reason: 'no-amount' };

  const customer = { fullName: o.fullName, phone: o.phone, email: o.email };
  const reference = String(opts.reference || opts.note || '').trim();
  const method = String(opts.method || '').trim();
  const isCash = method === 'cash';
  const payMethodId = (!isCash && canTaxInvoice && method && typeof adapter.payMethodAccountId === 'function')
    ? adapter.payMethodAccountId(method) : null;
  const hasPayment = isCash || payMethodId != null;

  let res;
  if (canTaxInvoice) {
    res = await adapter.createTaxInvoice({
      customer, items,
      description: 'הזמנה ' + o.orderCode,
      externalId: o.orderCode,
      invoiceType: hasPayment ? 1 : 305, // חשבונית מס קבלה w/ method, else חשבונית מס
      payMethodId,
      cash: isCash,
      reference,
      amountAgorot,
      sendByEmail: false, // we send our own final email (collected summary + invoice)
    });
  } else {
    res = await adapter.createDocument({
      customer, items,
      description: 'הזמנה ' + o.orderCode,
      externalId: o.orderCode,
      docType: 'TaxInvoice',
      paymentNote: reference,
      sendByEmail: false,
    });
  }
  if (!res || !res.ok) return { ok: false, reason: 'document-failed', error: (res && res.error) || 'הפקת החשבונית נכשלה.' };

  // Persist the invoice ref/url on a payments row so it surfaces in the order
  // detail (same place as card invoices). No amount is captured here.
  const now = new Date();
  const payment = (await db.select().from(paymentsT).where(eq(paymentsT.orderId, o.id)))[0];
  if (payment) {
    await db.update(paymentsT)
      .set({ invoiceRef: res.invoiceRef || null, invoiceUrl: res.invoiceUrl || null, updatedAt: now })
      .where(eq(paymentsT.id, payment.id));
  } else {
    await db.insert(paymentsT).values({
      orderId: o.id, provider: PAYMENT_PROVIDER, method: 'cash', status: 'none',
      invoiceRef: res.invoiceRef || null, invoiceUrl: res.invoiceUrl || null,
      createdAt: now, updatedAt: now,
    });
  }
  // A receipt/invoice for an external payment means the money was received →
  // mark the order paid (manual override; card charges set paymentStatus itself).
  await db.update(ordersT).set({ paymentStatusManual: 'paid', updatedAt: now }).where(eq(ordersT.id, o.id));
  return { ok: true, amount: amountAgorot / 100, invoiceUrl: res.invoiceUrl || '', invoiceRef: res.invoiceRef || '' };
}

// Issue the missing invoice for an order that was ALREADY charged on card but
// whose document failed at charge time. Links the receipt to the existing
// transaction (DealNumbers) — no re-charge. Refuses if there's already an
// invoice or no charge on file.
async function issueChargedInvoice(orderCode) {
  const o = await getOrderByCode(orderCode);
  if (!o) return { ok: false, reason: 'notfound' };
  const adapter = getPaymentAdapter();
  if (typeof adapter.createTaxInvoice !== 'function') return { ok: false, reason: 'unsupported' };

  const payment = (await db.select().from(paymentsT).where(eq(paymentsT.orderId, o.id)))[0];
  if (!payment || payment.status !== 'captured') return { ok: false, reason: 'not-charged' };
  if (payment.invoiceUrl || payment.invoiceRef) return { ok: false, reason: 'already-invoiced' };
  const dealNumber = payment.providerPaymentRef;
  if (!dealNumber) return { ok: false, reason: 'no-deal' };

  const { items, amountAgorot } = await buildOrderChargeItems(o);
  const res = await adapter.createTaxInvoice({
    customer: { fullName: o.fullName, phone: o.phone, email: o.email },
    items,
    description: 'הזמנה ' + o.orderCode,
    externalId: o.orderCode,
    invoiceType: 1, // חשבונית מס קבלה, linked to the credit deal
    dealNumber,
    amountAgorot,
    sendByEmail: false,
  });
  if (!res || !res.ok) return { ok: false, reason: 'document-failed', error: (res && res.error) || 'הפקת החשבונית נכשלה.' };

  await db.update(paymentsT)
    .set({ invoiceRef: res.invoiceRef || null, invoiceUrl: res.invoiceUrl || null, updatedAt: new Date() })
    .where(eq(paymentsT.id, payment.id));
  return { ok: true, invoiceUrl: res.invoiceUrl || '', invoiceRef: res.invoiceRef || '' };
}

// Manually change an order's payment method (cash ↔ credit) — allowed only
// before the order is charged (captured is locked; would need a refund).
async function setOrderPaymentMethod(orderCode, method) {
  const m = method === 'credit' ? 'credit' : 'cash';
  const o = await getOrderByCode(orderCode);
  if (!o) return { ok: false, reason: 'notfound' };
  if (o.paymentStatus === 'captured') return { ok: false, reason: 'locked' };
  await db.update(ordersT).set({ paymentMethod: m, updatedAt: new Date() }).where(eq(ordersT.id, o.id));
  return { ok: true, method: m };
}

// Manually override the DISPLAYED payment status (bookkeeping flag, independent
// of the real processor state): 'paid' | 'unpaid' | 'na', or '' to clear (revert
// to deriving from the real paymentStatus).
async function setOrderPaymentStatusManual(orderCode, status) {
  const allowed = ['paid', 'unpaid', 'na'];
  const s = allowed.indexOf(String(status || '')) !== -1 ? String(status) : null;
  const o = await getOrderByCode(orderCode);
  if (!o) return { ok: false, reason: 'notfound' };
  await db.update(ordersT).set({ paymentStatusManual: s, updatedAt: new Date() }).where(eq(ordersT.id, o.id));
  return { ok: true, paymentStatusManual: s };
}

// Apply the team's charge-review adjustments — add/remove items, change unit
// quantities, per-line + order-level discounts (resolved to agorot) — persist the
// net line totals + final items-total + order discount, then charge.
async function reviewAndCharge(orderCode, payload = {}) {
  const o = await getOrderByCode(orderCode);
  if (!o) return { ok: false, reason: 'notfound' };
  let payment = (await db.select().from(paymentsT).where(eq(paymentsT.orderId, o.id)))[0];

  // Manual card entry by the team (e.g. a cash order, or no card on file):
  // tokenize+save the card now, then charge it like any credit order.
  const token = payload.paymentToken ? String(payload.paymentToken).trim() : '';
  if (token) {
    const saved = await getPaymentAdapter().saveCard({
      singleUseToken: token,
      customer: { fullName: o.fullName, phone: o.phone, email: o.email },
    });
    if (!saved.ok) return { ok: false, reason: 'card-failed', error: saved.error || 'כרטיס האשראי לא אומת.' };
    const t = new Date();
    if (payment) {
      await db.update(paymentsT)
        .set({ provider: PAYMENT_PROVIDER, method: 'credit', status: 'authorized', providerCustomerRef: saved.customerRef || null, cardExpiry: saved.cardExpiry || null, updatedAt: t })
        .where(eq(paymentsT.id, payment.id));
      payment.providerCustomerRef = saved.customerRef;
      payment.cardExpiry = saved.cardExpiry || null;
      payment.status = 'authorized';
    } else {
      const [row] = await db.insert(paymentsT)
        .values({ orderId: o.id, provider: PAYMENT_PROVIDER, method: 'credit', status: 'authorized', providerCustomerRef: saved.customerRef || null, cardExpiry: saved.cardExpiry || null, createdAt: t, updatedAt: t })
        .returning({ id: paymentsT.id });
      payment = { id: row.id, providerCustomerRef: saved.customerRef, cardExpiry: saved.cardExpiry || null, status: 'authorized' };
    }
    if (o.paymentMethod !== 'credit') {
      await db.update(ordersT).set({ paymentMethod: 'credit', updatedAt: t }).where(eq(ordersT.id, o.id));
      o.paymentMethod = 'credit';
    }
  }

  if (o.paymentMethod !== 'credit') return { ok: false, reason: 'not-credit' };
  if (!payment || !payment.providerCustomerRef) return { ok: false, reason: 'no-card' };
  if (o.paymentStatus === 'captured' || payment.status === 'captured') {
    return { ok: true, alreadyCharged: true, amount: (payment.capturedAmountAgorot || 0) / 100, invoiceUrl: payment.invoiceUrl || '' };
  }

  const applied = await applyReviewAdjustments(o, payload);
  if (!applied.ok) return applied;
  return chargeOrder(orderCode);
}

// Persist the team's charge-review adjustments (add/remove items, change unit
// quantities / weights, per-line + order-level discounts, delivery) → the net
// line totals + items-total + order discount. Shared by the card charge and the
// external-payment document flows. Returns { ok, itemsNetTotal } or a reason.
async function applyReviewAdjustments(o, payload = {}) {
  const existing = await getItems(o.id);
  // Missing (חסר) items are never billed or removed here — only collected lines.
  const billableExisting = existing.filter((it) => it.pickStatus !== ITEM_PICK_MISSING);
  const byId = new Map(billableExisting.map((it) => [String(it.id), it]));
  const reqItems = Array.isArray(payload.items) ? payload.items : [];

  // Look up any newly-added products for their pricing snapshot.
  const newIds = [...new Set(reqItems.filter((r) => !r.id && r.productId && isUuid(String(r.productId))).map((r) => String(r.productId)))];
  const prodById = new Map(
    (newIds.length ? await db.select().from(productsT).where(inArray(productsT.id, newIds)) : []).map((p) => [String(p.id), p]),
  );

  let itemsNetTotal = 0;
  const toUpdate = [];
  const toInsert = [];
  const keepIds = new Set();

  for (const r of reqItems) {
    const discount = Math.max(0, Math.round(Number(r.discountAgorot) || 0));
    if (r.id && byId.has(String(r.id))) {
      const it = byId.get(String(r.id));
      keepIds.add(String(r.id));
      const isWeight = getUnitType(it.priceUnit) === 'kg';
      let billable;
      let actualWeightKg = null;
      let qtyStr;
      if (isWeight) {
        const w = (r.weightKg != null && r.weightKg !== '')
          ? Math.max(0, Number(r.weightKg) || 0)
          : (it.actualWeightKg != null ? Number(it.actualWeightKg) : 0);
        billable = Math.round(w * (it.unitPriceAgorot || 0));
        actualWeightKg = w > 0 ? String(w) : null;
        qtyStr = String(Number(it.quantity));
      } else {
        const qty = Math.max(0, Number(r.quantity != null ? r.quantity : it.quantity));
        billable = it.unitPriceAgorot ? Math.round(applyUnitDeal(qty, it.unitPriceAgorot, it.dealQty, it.dealPriceAgorot)) : (it.lineTotalAgorot || 0);
        qtyStr = String(qty);
      }
      const net = Math.max(0, billable - discount);
      itemsNetTotal += net;
      toUpdate.push({ id: it.id, quantity: qtyStr, actualLineTotalAgorot: net, actualWeightKg, discountAgorot: discount });
    } else if (r.productId && prodById.has(String(r.productId))) {
      const p = prodById.get(String(r.productId));
      const isKg = getUnitType(p.priceUnit || p.unit) === 'kg';
      let qty = 1;
      let billable = 0;
      let actualWeightKg = null;
      let mode = 'unit';
      if (isKg) {
        const w = Math.max(0, Number(r.weightKg) || 0);
        billable = Math.round(w * (p.priceAgorot || 0));
        actualWeightKg = w > 0 ? String(w) : null;
        mode = 'kg';
      } else {
        qty = Math.max(1, Math.round(Number(r.quantity) || 1));
        billable = p.priceAgorot ? Math.round(applyUnitDeal(qty, p.priceAgorot, p.dealQty, p.dealPriceAgorot)) : 0;
      }
      const net = Math.max(0, billable - discount);
      itemsNetTotal += net;
      toInsert.push({
        orderId: o.id, productId: p.id, productName: p.name, department: p.department || '',
        mode, quantity: String(qty), orderUnit: p.unit || '', unitPriceAgorot: p.priceAgorot || 0,
        priceUnit: p.priceUnit || p.unit || '', dealQty: p.dealQty || null, dealPriceAgorot: p.dealPriceAgorot || null,
        vatExempt: p.vatExempt !== false,
        lineTotalAgorot: billable, actualWeightKg, actualLineTotalAgorot: net, discountAgorot: discount,
        pickStatus: ITEM_PICK_COLLECTED, sortOrder: 999,
      });
    }
  }

  if (!toUpdate.length && !toInsert.length) return { ok: false, reason: 'no-items' };

  const orderDiscount = Math.max(0, Math.round(Number(payload.orderDiscountAgorot) || 0));
  const deliveryFee = payload.deliveryAgorot != null
    ? Math.max(0, Math.round(Number(payload.deliveryAgorot) || 0))
    : (o.deliveryFeeAgorot || 0);
  const now = new Date();
  await db.transaction(async (tx) => {
    // Only collected lines the team explicitly dropped are removed; missing items stay.
    const removeIds = billableExisting.filter((it) => !keepIds.has(String(it.id))).map((it) => it.id);
    if (removeIds.length) await tx.delete(orderItemsT).where(inArray(orderItemsT.id, removeIds));
    for (const u of toUpdate) {
      await tx.update(orderItemsT)
        .set({ quantity: u.quantity, actualLineTotalAgorot: u.actualLineTotalAgorot, actualWeightKg: u.actualWeightKg, discountAgorot: u.discountAgorot })
        .where(eq(orderItemsT.id, u.id));
    }
    if (toInsert.length) await tx.insert(orderItemsT).values(toInsert);
    await tx.update(ordersT)
      .set({ discountAgorot: orderDiscount, deliveryFeeAgorot: deliveryFee, actualTotalAgorot: itemsNetTotal, updatedAt: now })
      .where(eq(ordersT.id, o.id));
  });

  return { ok: true, itemsNetTotal };
}

// Charge-review flow for an order paid OUTSIDE Cardcom: apply the same review
// adjustments, then issue a חשבונית מס (with a payment note) instead of charging.
async function reviewAndIssueDocument(orderCode, payload = {}) {
  const o = await getOrderByCode(orderCode);
  if (!o) return { ok: false, reason: 'notfound' };
  const applied = await applyReviewAdjustments(o, payload);
  if (!applied.ok) return applied;
  return issueOrderDocument(orderCode, { method: payload.method, reference: payload.reference, note: payload.note });
}

// Team-created invoice (POS): build a new collected order from a product list,
// then optionally charge a card immediately (cash = create only).
async function createManualOrder(payload = {}) {
  const c = payload.customer || {};
  const fullName = String(c.fullName || '').trim() || 'לקוח מזדמן';
  const phone = normalizeCustomerPhone(c.phone || '');
  const email = String(c.email || '').trim();
  const reqItems = Array.isArray(payload.items) ? payload.items : [];
  if (!reqItems.length) return { ok: false, reason: 'no-items' };

  const ids = [...new Set(reqItems.map((r) => String(r.productId)).filter(isUuid))];
  const prodById = new Map(
    (ids.length ? await db.select().from(productsT).where(inArray(productsT.id, ids)) : []).map((p) => [String(p.id), p]),
  );

  const now = new Date();
  const itemValues = [];
  let itemsTotal = 0;
  reqItems.forEach((r, i) => {
    const p = prodById.get(String(r.productId));
    if (!p) return;
    const isKg = getUnitType(p.priceUnit || p.unit) === 'kg';
    const discount = Math.max(0, Math.round(Number(r.discountAgorot) || 0));
    let qty = 1;
    let billable = 0;
    let actualWeightKg = null;
    let mode = 'unit';
    if (isKg) {
      const w = Math.max(0, Number(r.weightKg) || 0);
      billable = Math.round(w * (p.priceAgorot || 0));
      actualWeightKg = w > 0 ? String(w) : null;
      mode = 'kg';
    } else {
      qty = Math.max(1, Math.round(Number(r.quantity) || 1));
      billable = p.priceAgorot ? Math.round(applyUnitDeal(qty, p.priceAgorot, p.dealQty, p.dealPriceAgorot)) : 0;
    }
    const net = Math.max(0, billable - discount);
    itemsTotal += net;
    itemValues.push({
      productId: p.id, productName: p.name, department: p.department || '',
      mode, quantity: String(qty), orderUnit: p.unit || '', unitPriceAgorot: p.priceAgorot || 0,
      priceUnit: p.priceUnit || p.unit || '', dealQty: p.dealQty || null, dealPriceAgorot: p.dealPriceAgorot || null,
      vatExempt: p.vatExempt !== false,
      lineTotalAgorot: billable, actualWeightKg, actualLineTotalAgorot: net, discountAgorot: discount,
      pickStatus: ITEM_PICK_COLLECTED, sortOrder: i,
    });
  });
  if (!itemValues.length) return { ok: false, reason: 'no-items' };

  const orderDiscount = Math.max(0, Math.round(Number(payload.orderDiscountAgorot) || 0));
  const deliveryFee = Math.max(0, Math.round(Number(payload.deliveryAgorot) || 0));
  const grandTotalAgorot = Math.max(0, itemsTotal - orderDiscount) + deliveryFee;
  const wantsCredit = payload.paymentMethod === 'credit';
  const orderCode = generateOrderId();
  const saleName = await currentSaleName();

  await db.transaction(async (tx) => {
    let customerId = null;
    if (phone) customerId = await upsertCustomer(tx, { phone, fullName, email });
    const [o] = await tx.insert(ordersT).values({
      orderCode, fullName, phone: phone || '', email,
      fulfillment: 'איסוף עצמי', neighborhood: '', address: '', floor: '', apartment: '',
      notes: String(payload.notes || '').trim(),
      saleName, customerId, status: ORDER_STATUS_COLLECTED, origin: 'manual',
      estimatedTotalAgorot: itemsTotal, deliveryFeeAgorot: deliveryFee, grandTotalAgorot,
      actualTotalAgorot: itemsTotal, discountAgorot: orderDiscount, unpricedItemCount: 0,
      editToken: generateEditToken(),
      paymentMethod: wantsCredit ? 'credit' : 'cash', paymentStatus: 'none',
      collectedBy: String(payload.member || '').trim(), pickedAt: now,
      createdAt: now, updatedAt: now,
    }).returning({ id: ordersT.id });
    await tx.insert(orderItemsT).values(itemValues.map((v) => ({ ...v, orderId: o.id })));
  });

  // Two-step "immediate charge": the cart is final, so charge the card in a single
  // hosted ChargeAndCreateToken operation. We create the order now (no charge yet),
  // open a LowProfile carrying the exact amount + invoice document, and return its
  // id; the browser loads the card fields against it and submits → Cardcom charges
  // + issues the invoice in one go. finalizeHostedCharge() then records the result.
  if (wantsCredit && payload.hostedCharge) {
    const sess = await createHostedChargeSession(orderCode);
    if (!sess.ok || !sess.lowProfileId) {
      return { ok: true, orderId: orderCode, charged: false, chargeError: sess.error || 'לא הצלחנו לפתוח את טופס התשלום.' };
    }
    return { ok: true, orderId: orderCode, charged: false, hostedCharge: true, lowProfileId: sess.lowProfileId, amount: sess.amount };
  }

  if (wantsCredit) {
    const token = payload.paymentToken ? String(payload.paymentToken).trim() : '';
    if (!token) return { ok: true, orderId: orderCode, charged: false };
    const saved = await getPaymentAdapter().saveCard({ singleUseToken: token, customer: { fullName, phone, email } });
    if (!saved.ok) return { ok: true, orderId: orderCode, charged: false, chargeError: saved.error || 'כרטיס האשראי לא אומת.' };
    const o2 = await getOrderByCode(orderCode);
    await db.insert(paymentsT).values({
      orderId: o2.id, provider: PAYMENT_PROVIDER, method: 'credit', status: 'authorized',
      providerCustomerRef: saved.customerRef || null, cardExpiry: saved.cardExpiry || null, createdAt: now, updatedAt: now,
    });
    const charge = await chargeOrder(orderCode);
    if (!charge.ok) return { ok: true, orderId: orderCode, charged: false, chargeError: charge.error || charge.reason };
    return { ok: true, orderId: orderCode, charged: true, amount: charge.amount, invoiceUrl: charge.invoiceUrl };
  }

  // Cash / external payment: optionally issue a חשבונית מס for the new order.
  if (payload.issueDocument) {
    const doc = await issueOrderDocument(orderCode, { method: payload.docMethod, reference: payload.docReference || payload.docNote, note: payload.docNote });
    if (doc.ok) return { ok: true, orderId: orderCode, charged: false, documentIssued: true, amount: doc.amount, invoiceUrl: doc.invoiceUrl };
    return { ok: true, orderId: orderCode, charged: false, documentError: doc.error || doc.reason, amount: grandTotalAgorot / 100 };
  }

  return { ok: true, orderId: orderCode, charged: false, amount: grandTotalAgorot / 100 };
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

// Team edit of an order: change customer details, item quantities, remove items,
// and ADD products, recompute totals. Keeps status/saleName/createdAt.
// payload: { fullName, phone, email, fulfillment, address, floor, apartment,
//            notes, items: [{ id, quantity } | { productId, quantity }] }
//            (kept existing rows carry id; new products carry productId; qty 0 = remove)
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
  // Newly-added products in the edit form (rows with a productId and no id).
  const reqItems = payload.items || [];
  const newIds = [...new Set(reqItems.filter((r) => !r.id && r.productId && isUuid(String(r.productId))).map((r) => String(r.productId)))];
  const prodById = new Map(
    (newIds.length ? await db.select().from(productsT).where(inArray(productsT.id, newIds)) : []).map((p) => [String(p.id), p]),
  );
  const toInsert = [];
  for (const r of reqItems) {
    if (r.id || !r.productId) continue;
    const p = prodById.get(String(r.productId));
    if (!p) continue;
    const qty = Math.max(0, Number(r.quantity) || 0);
    if (!(qty > 0)) continue;
    const isKg = getUnitType(p.priceUnit || p.unit) === 'kg';
    const hasWpu = isKg && p.weightPerUnitKg != null;
    const snap = {
      priceUnit: p.priceUnit || p.unit,
      unitPriceAgorot: p.priceAgorot || 0,
      lineTotalAgorot: 0,
      mode: hasWpu ? 'unit' : (isKg ? 'kg' : 'unit'),
      estimatedWeightPerUnitKg: hasWpu ? Number(p.weightPerUnitKg) : null,
    };
    const line = recomputeLine(snap, qty);
    if (line.lineTotalAgorot != null) estimatedTotalAgorot += line.lineTotalAgorot;
    else unpricedItemCount += 1;
    toInsert.push({
      orderId: o.id, productId: p.id, productName: p.name, department: p.department || '',
      mode: snap.mode, quantity: String(qty), orderUnit: p.unit || '',
      unitPriceAgorot: p.priceAgorot || 0, priceUnit: p.priceUnit || p.unit || '',
      dealQty: p.dealQty || null, dealPriceAgorot: p.dealPriceAgorot || null,
      vatExempt: p.vatExempt !== false,
      lineTotalAgorot: line.lineTotalAgorot,
      estimatedWeightKg: line.estimatedWeightKg,
      estimatedWeightPerUnitKg: snap.estimatedWeightPerUnitKg != null ? String(snap.estimatedWeightPerUnitKg) : null,
      sortOrder: 999,
    });
  }
  if (!updates.length && !toInsert.length) throw new Error('לא ניתן להשאיר הזמנה ללא מוצרים. לביטול ההזמנה השתמשו בכפתור הביטול.');

  const fulfillment = payload.fulfillment || o.fulfillment;
  const dRules = resolveDelivery(await getSettings());
  const deliveryFeeAgorot =
    fulfillment === 'משלוח' && estimatedTotalAgorot < dRules.threshold * 100 ? dRules.fee * 100 : 0;
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
    if (toInsert.length) await tx.insert(orderItemsT).values(toInsert);
  });

  return { ok: true, grandTotal: grandTotalAgorot / 100, itemCount: updates.length + toInsert.length };
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
    vatExempt: p.vatExempt !== false,
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
    vatExempt: product.vatExempt !== false,
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
  if (product.vatExempt !== undefined) set.vatExempt = !!product.vatExempt;
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
  'orderCutoffDay', 'weeklyReminderEnabled', 'weeklyReminderDay',
  'weeklyReminderTime', 'weeklyReminderText',
  'freeDeliveryThreshold', 'deliveryFee', 'contactPhone', 'contactEmail',
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
  getWeeklyReport,
  getOrdersTimeline,
  getCustomers,
  getWeightSummary,
  getOrdersDetailed,
  readOrderForDashboard,
  claimOrderForPicking,
  updateOrderCollection,
  setOrderStatus,
  chargeOrder,
  createHostedChargeSession,
  finalizeHostedCharge,
  getOrdersPaymentInfo,
  openCombinedCardSession,
  collectPayment,
  reviewAndCharge,
  issueOrderDocument,
  reviewAndIssueDocument,
  issueChargedInvoice,
  setOrderPaymentMethod,
  setOrderPaymentStatusManual,
  createManualOrder,
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
