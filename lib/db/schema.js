/**
 * Prinuk database schema (Drizzle ORM / Postgres).
 *
 * Design notes:
 * - Money is stored as integer AGOROT (₪1.00 = 100). Never floats.
 * - Weights are Postgres `numeric` in kilograms (exact, not float).
 * - Hebrew status / fulfillment / pick values are stored verbatim so the
 *   existing dashboard + API contracts (team/index.html, api/dashboard.js)
 *   keep working unchanged after the cutover.
 * - Tables for payments/transactions/audit are defined now (Stage 1) but only
 *   exercised in later stages (J5 authorize/capture, invoicing).
 *
 * Written in CommonJS JS (not TS) for Stage 1 so the existing CommonJS runtime
 * (api/*.js, Vercel functions, smoke test) can require it directly. Full
 * TypeScript arrives with the Stage 6 framework migration.
 */
const {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} = require('drizzle-orm/pg-core');

// --- Enums (Hebrew values preserved where they cross the API boundary) ---

const fulfillmentEnum = pgEnum('fulfillment', ['משלוח', 'איסוף עצמי']);

const orderStatusEnum = pgEnum('order_status', [
  'חדש', // new
  'בליקוט', // picking
  'נאסף', // collected
  'נאסף חלקית', // partial
  'נשלח', // sent (delivery)
  'נמסר', // handed (pickup)
  'מבוטל', // cancelled (soft delete — hidden from active list + reports)
]);

const itemPickStatusEnum = pgEnum('item_pick_status', ['נאסף', 'חסר']);

const productStateEnum = pgEnum('product_state', ['active', 'oos', 'hidden']);

const itemModeEnum = pgEnum('item_mode', ['unit', 'kg']);

const paymentMethodEnum = pgEnum('payment_method', ['cash', 'credit']);

const paymentStatusEnum = pgEnum('payment_status', [
  'none',
  'authorized', // J5 hold placed
  'captured',
  'partially_captured',
  'failed',
  'refunded',
  'voided',
]);

const transactionTypeEnum = pgEnum('transaction_type', [
  'authorize',
  'capture',
  'void',
  'refund',
]);

const transactionStatusEnum = pgEnum('transaction_status', [
  'pending',
  'success',
  'failed',
]);

// --- Settings (key/value, mirrors the הגדרות sheet) ---

const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- Products (catalog, mirrors the מוצרים sheet) ---

const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    department: text('department').notNull().default('אחר'),
    unit: text('unit').notNull().default('יחידות'),
    priceUnit: text('price_unit').notNull().default('יחידות'),
    priceAgorot: integer('price_agorot').notNull().default(0),
    state: productStateEnum('state').notNull().default('active'),
    // Per-unit estimated weight override (kg). Null → fall back to the
    // name-keyed UNIT_WEIGHT_ESTIMATES_KG map in code.
    weightPerUnitKg: numeric('weight_per_unit_kg', { precision: 7, scale: 3 }),
    imageUrl: text('image_url').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index('products_name_idx').on(t.name),
    stateIdx: index('products_state_idx').on(t.state),
  }),
);

// --- Customers (keyed by normalised phone; new vs. the sheet system) ---

const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull(), // normalised 05XXXXXXXX
    fullName: text('full_name').notNull().default(''),
    email: text('email').notNull().default(''),
    // Forward-looking: a payment-processor customer token (NEVER card data).
    providerCustomerRef: text('provider_customer_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    phoneUniqueIdx: uniqueIndex('customers_phone_unique_idx').on(t.phone),
  }),
);

// --- Orders (mirrors the הזמנות sheet, cols A:Y, plus payment summary) ---

const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The human-facing "P-YYYYMMDD-HHMMSS-NNNN" id used in emails/links.
    orderCode: text('order_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    // Denormalised customer fields (authoritative for this order, audit-safe).
    fullName: text('full_name').notNull(),
    phone: text('phone').notNull(),
    email: text('email').notNull().default(''),

    fulfillment: fulfillmentEnum('fulfillment').notNull(),
    neighborhood: text('neighborhood').notNull().default(''),
    address: text('address').notNull().default(''),
    floor: text('floor').notNull().default(''),
    apartment: text('apartment').notNull().default(''),
    notes: text('notes').notNull().default(''),

    // The sale this order belongs to (stamped at checkout from settings.saleName)
    // so reports/lists can be scoped per-sale now that orders are never cleared.
    saleName: text('sale_name').notNull().default(''),

    status: orderStatusEnum('status').notNull().default('חדש'),

    estimatedTotalAgorot: integer('estimated_total_agorot').notNull().default(0),
    deliveryFeeAgorot: integer('delivery_fee_agorot').notNull().default(0),
    grandTotalAgorot: integer('grand_total_agorot').notNull().default(0),
    unpricedItemCount: integer('unpriced_item_count').notNull().default(0),
    // Final weighed total (Stage 2); null until the team finishes weighing.
    actualTotalAgorot: integer('actual_total_agorot'),

    editToken: text('edit_token').notNull(),

    // Team picking attribution (sheet cols X:Y).
    collectedBy: text('collected_by').notNull().default(''),
    pickedAt: timestamp('picked_at', { withTimezone: true }),

    // Notification statuses (sheet cols P:U).
    customerEmailStatus: text('customer_email_status').notNull().default(''),
    customerEmailError: text('customer_email_error').notNull().default(''),
    businessEmailStatus: text('business_email_status').notNull().default(''),
    businessEmailError: text('business_email_error').notNull().default(''),
    telegramStatus: text('telegram_status').notNull().default(''),
    telegramError: text('telegram_error').notNull().default(''),

    // Payment summary (Stage 4/5); detail lives in payments/transactions.
    paymentMethod: paymentMethodEnum('payment_method'),
    paymentStatus: paymentStatusEnum('payment_status').notNull().default('none'),
  },
  (t) => ({
    orderCodeUniqueIdx: uniqueIndex('orders_order_code_unique_idx').on(t.orderCode),
    statusIdx: index('orders_status_idx').on(t.status),
    saleNameIdx: index('orders_sale_name_idx').on(t.saleName),
    createdAtIdx: index('orders_created_at_idx').on(t.createdAt),
    phoneIdx: index('orders_phone_idx').on(t.phone),
  }),
);

// --- Order items (mirrors the פריטי הזמנות sheet, plus weighing fields) ---

const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    // Catalog product at order time (null-safe: catalog changes weekly).
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    productName: text('product_name').notNull(),
    department: text('department').notNull().default(''),

    mode: itemModeEnum('mode').notNull().default('unit'),
    quantity: numeric('quantity', { precision: 10, scale: 3 }).notNull(),
    orderUnit: text('order_unit').notNull().default(''),
    unitPriceAgorot: integer('unit_price_agorot').notNull().default(0),
    priceUnit: text('price_unit').notNull().default(''),
    // Null line total = "לפי חישוב בפועל" (priced at picking).
    lineTotalAgorot: integer('line_total_agorot'),

    estimatedWeightKg: numeric('estimated_weight_kg', { precision: 7, scale: 3 }),
    estimatedWeightPerUnitKg: numeric('estimated_weight_per_unit_kg', { precision: 7, scale: 3 }),
    isEstimatedPriceTotal: boolean('is_estimated_price_total').notNull().default(false),
    isEstimatedWeightTotal: boolean('is_estimated_weight_total').notNull().default(false),

    note: text('note').notNull().default(''),
    // Null = pending (sheet blank); otherwise נאסף / חסר.
    pickStatus: itemPickStatusEnum('pick_status'),

    // Actual collected values (Stage 2); null until collected.
    actualWeightKg: numeric('actual_weight_kg', { precision: 7, scale: 3 }), // kg-priced items
    actualQuantity: numeric('actual_quantity', { precision: 10, scale: 3 }), // unit-priced items
    actualLineTotalAgorot: integer('actual_line_total_agorot'),

    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    orderIdIdx: index('order_items_order_id_idx').on(t.orderId),
  }),
);

// --- Payments (one row per order; the J5 authorize/capture lifecycle) ---

const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default(''), // e.g. 'cardcom'
    method: paymentMethodEnum('method').notNull(),
    status: paymentStatusEnum('status').notNull().default('none'),
    currency: text('currency').notNull().default('ILS'),

    authorizedAmountAgorot: integer('authorized_amount_agorot'), // J5 hold
    capturedAmountAgorot: integer('captured_amount_agorot'),

    // Processor references only — NEVER raw card data.
    providerCustomerRef: text('provider_customer_ref'),
    providerPaymentRef: text('provider_payment_ref'),
    invoiceRef: text('invoice_ref'),
    invoiceUrl: text('invoice_url'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdIdx: index('payments_order_id_idx').on(t.orderId),
  }),
);

// --- Transactions (append-only log of each processor call/webhook) ---

const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id'), // denormalised for querying
    type: transactionTypeEnum('type').notNull(),
    status: transactionStatusEnum('status').notNull().default('pending'),
    amountAgorot: integer('amount_agorot'),
    // Guards against double-charges on retries/webhook replays.
    idempotencyKey: text('idempotency_key'),
    providerRef: text('provider_ref'),
    errorMessage: text('error_message').notNull().default(''),
    raw: jsonb('raw'), // raw provider response / webhook payload
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    paymentIdIdx: index('transactions_payment_id_idx').on(t.paymentId),
    orderIdIdx: index('transactions_order_id_idx').on(t.orderId),
    idempotencyKeyUniqueIdx: uniqueIndex('transactions_idempotency_key_unique_idx').on(
      t.idempotencyKey,
    ),
  }),
);

// --- Audit log (append-only, general) ---

const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    actor: text('actor').notNull().default(''), // team member / 'system' / 'customer'
    action: text('action').notNull(), // e.g. 'order.create', 'order.status', 'payment.capture'
    orderId: uuid('order_id'),
    entity: text('entity'),
    entityId: text('entity_id'),
    detail: jsonb('detail'),
  },
  (t) => ({
    orderIdIdx: index('audit_log_order_id_idx').on(t.orderId),
    createdAtIdx: index('audit_log_created_at_idx').on(t.createdAt),
  }),
);

module.exports = {
  fulfillmentEnum,
  orderStatusEnum,
  itemPickStatusEnum,
  productStateEnum,
  itemModeEnum,
  paymentMethodEnum,
  paymentStatusEnum,
  transactionTypeEnum,
  transactionStatusEnum,
  settings,
  products,
  customers,
  orders,
  orderItems,
  payments,
  transactions,
  auditLog,
};
