const { google } = require('googleapis');

const CATEGORY_ORDER = ['ירקות', 'פירות', 'עלים', 'מיוחדים'];

const DEFAULTS = {
  title: 'פרינוק - המכירה השבועית',
  description: 'בחרו את הפירות והירקות שתרצו להזמין.',
  closedMessage: 'ההזמנות עוד לא נפתחו. הטופס ייפתח בקרוב.',
  pickupText: 'המכירה תתקיים ביום שלישי ברחוב עוזיאל 101 בין השעות 10:00-19:00',
  contactPhone: '0535234975',
  contactEmail: 'prinuk10@gmail.com',
};

const PRODUCTS_SHEET = 'מוצרים';
const SETTINGS_SHEET = 'הגדרות';
const ORDERS_SHEET = 'הזמנות';
const ORDER_ITEMS_SHEET = 'פריטי הזמנות';
const PICKING_SHEET = 'דפי ליקוט';
const VERCEL_IN_PROGRESS_STATUS = 'בטיפול מ-Vercel';

const ORDER_HEADERS = [
  'זמן', 'מספר הזמנה', 'גיליון מוצרים', 'שם מלא', 'טלפון',
  'שיטת הזמנה', 'כתובת', 'קומה', 'דירה', 'הערות',
  'מספר שורות', 'סטטוס', 'סכום משוער', 'פריטים ללא חישוב',
  'אימייל לקוח', 'סטטוס מייל לקוח', 'שגיאת מייל לקוח',
  'סטטוס מייל פרינוק', 'שגיאת מייל פרינוק',
  'סטטוס טלגרם פרינוק', 'שגיאת טלגרם פרינוק',
];

const ORDER_ITEM_HEADERS = [
  'זמן', 'מספר הזמנה', 'מוצר', 'מחלקה', 'שיטת כמות',
  'כמות', 'יחידת הזמנה', 'מחיר מהגיליון', 'יחידת מחיר', 'סכום מחושב',
  'הערת מוצר',
];

let _authClient = null;

async function getAuthClient() {
  if (_authClient) return _authClient;

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  _authClient = await auth.getClient();
  return _authClient;
}

async function getSheetsClient() {
  const auth = await getAuthClient();
  return google.sheets({ version: 'v4', auth });
}

function getSpreadsheetId() {
  return process.env.SPREADSHEET_ID;
}

// --- Settings ---

function parseSettings(rows) {
  const settings = {
    title: DEFAULTS.title,
    description: DEFAULTS.description,
    closedMessage: DEFAULTS.closedMessage,
    saleName: '',
    pickupText: DEFAULTS.pickupText,
    logoUrl: '',
    notificationEmails: '',
    telegramBotToken: '',
    telegramChatId: '',
    contactPhone: DEFAULTS.contactPhone,
    contactEmail: DEFAULTS.contactEmail,
  };

  if (!rows || rows.length < 2) return settings;

  const keyMap = {
    'כותרת': 'title',
    'תיאור': 'description',
    'הודעה כשההזמנות סגורות': 'closedMessage',
    'הודעת סגירה': 'closedMessage',
    'הודעה לפני פתיחת הזמנות': 'closedMessage',
    'שם מכירה': 'saleName',
    'פרטי איסוף': 'pickupText',
    'לוגו': 'logoUrl',
    'לוגו URL': 'logoUrl',
    'קישור לוגו': 'logoUrl',
    'אימייל התראות': 'notificationEmails',
    'מייל התראות': 'notificationEmails',
    'Email notifications': 'notificationEmails',
    'טלגרם בוט טוקן': 'telegramBotToken',
    'Telegram bot token': 'telegramBotToken',
    'טלגרם צ׳אט ID': 'telegramChatId',
    'טלגרם צאט ID': 'telegramChatId',
    'Telegram chat ID': 'telegramChatId',
    'טלפון ליצירת קשר': 'contactPhone',
    'טלפון קשר': 'contactPhone',
    'מייל ליצירת קשר': 'contactEmail',
    'אימייל ליצירת קשר': 'contactEmail',
  };

  for (let i = 1; i < rows.length; i++) {
    const key = String(rows[i][0] || '').trim();
    const value = String(rows[i][1] || '').trim();
    if (!key || !value) continue;

    const field = keyMap[key];
    if (field) settings[field] = value;
  }

  return settings;
}

// --- Products ---

function normalizeHeader(value) {
  return String(value || '').trim().replace(/[״"]/g, '"').replace(/[׳']/g, "'").replace(/\s+/g, ' ').toLowerCase();
}

function buildColumnMap(headers) {
  const map = { name: 0, department: 1, unit: 2, priceUnit: null, price: 3, active: null };

  headers.forEach((header, index) => {
    const v = normalizeHeader(header);
    if (!v) return;

    if (v === 'שם' || v === 'שם מוצר' || v === 'מוצר' || v === 'name' || v === 'product') {
      map.name = index;
    } else if (v.includes('מחלקה') || v.includes('קטגוריה') || v === 'department' || v === 'category') {
      map.department = index;
    } else if ((v.includes('יחידת') && v.includes('מחיר')) || v === 'יחידת מחיר' || v === 'price unit') {
      map.priceUnit = index;
    } else if (v.includes('יחידת') || v === 'יחידה' || v === 'unit') {
      map.unit = index;
    } else if (v.includes('מחיר') || v === 'price') {
      map.price = index;
    } else if (v.includes('פעיל') || v.includes('זמין') || v === 'active' || v === 'available') {
      map.active = index;
    }
  });

  return map;
}

function normalizeDepartment(value) {
  const dept = String(value || '').trim();
  const n = dept.replace(/[״"]/g, '"').replace(/\s+/g, '').toLowerCase();
  if (!n) return 'אחר';
  if (n === 'ירק' || n === 'ירקות') return 'ירקות';
  if (n === 'פרי' || n === 'פירות') return 'פירות';
  if (n === 'עלה' || n === 'עלים') return 'עלים';
  if (n === 'מיוחד' || n === 'מיוחדים') return 'מיוחדים';
  return dept;
}

function getUnitType(unit) {
  const v = String(unit || '').trim().replace(/[״"]/g, '"').replace(/\s+/g, '');
  if (v.includes('קג') || v.includes('ק"ג')) return 'kg';
  return 'unit';
}

function parsePrice(value) {
  if (typeof value === 'number') return value;
  const cleaned = String(value || '').replace(/[^\d.,-]/g, '').replace(',', '.');
  return Number(cleaned) || 0;
}

function isActive(value) {
  if (value === '' || value === null || value === undefined) return true;
  if (value === true) return true;
  if (value === false) return false;
  const text = String(value).trim().toLowerCase();
  return !['לא', 'לא פעיל', 'לא זמין', 'false', 'no', '0', 'כבוי'].includes(text);
}

function formatPrice(value) {
  const rounded = Math.round(value * 100) / 100;
  if (Math.abs(rounded - Math.round(rounded)) < 0.000001) return String(Math.round(rounded));
  return String(rounded).replace(/0+$/, '').replace(/\.$/, '');
}

function parseProducts(rows) {
  if (!rows || rows.length < 2) return [];

  const headers = rows[0];
  const columns = buildColumnMap(headers);
  const products = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = String(row[columns.name] || '').trim();
    const department = normalizeDepartment(row[columns.department]);
    const unit = String(row[columns.unit] || '').trim() || 'יחידות';
    const priceUnit = columns.priceUnit === null
      ? unit
      : String(row[columns.priceUnit] || '').trim() || unit;
    const price = parsePrice(row[columns.price]);
    const active = columns.active === null ? true : isActive(row[columns.active]);

    if (!name || !active || !price || price <= 0) continue;

    products.push({
      id: 'r' + (i + 1),
      rowNumber: i + 1,
      name,
      department,
      unit,
      priceUnit,
      unitType: getUnitType(unit),
      price,
      priceDisplay: formatPrice(price),
    });
  }

  return products;
}

function groupProducts(products) {
  const byDept = {};
  products.forEach(p => {
    if (!byDept[p.department]) byDept[p.department] = [];
    byDept[p.department].push(p);
  });

  const order = CATEGORY_ORDER.slice();
  Object.keys(byDept).forEach(d => {
    if (!order.includes(d)) order.push(d);
  });

  return order
    .filter(d => byDept[d] && byDept[d].length)
    .map(d => {
      byDept[d].sort((a, b) => a.name.localeCompare(b.name, 'he'));
      return { name: d, products: byDept[d] };
    });
}

// --- Orders ---

function isWholeNumber(v) { return Math.abs(v - Math.round(v)) < 0.000001; }
function isHalfStep(v) { return Math.abs(v * 2 - Math.round(v * 2)) < 0.000001; }
function roundMoney(v) { return Math.round(v * 100) / 100; }

function canCalculateLineTotal(mode, priceUnit) {
  const priceUnitType = getUnitType(priceUnit);
  return mode === 'kg' ? priceUnitType === 'kg' : priceUnitType === 'unit';
}

function generateOrderId() {
  const now = new Date();
  const pad = (n, len) => String(n).padStart(len, '0');
  const ts = [
    now.getFullYear(),
    pad(now.getMonth() + 1, 2),
    pad(now.getDate(), 2),
    '-',
    pad(now.getHours(), 2),
    pad(now.getMinutes(), 2),
    pad(now.getSeconds(), 2),
  ].join('');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return 'P-' + ts + '-' + rand;
}

function validateAndBuildOrder(payload, products) {
  const productMap = {};
  products.forEach(p => { productMap[p.id] = p; });

  const customer = payload.customer || {};
  const delivery = payload.delivery || {};
  const items = payload.items || [];
  const notes = String(payload.notes || '').trim();

  const fullName = String(customer.fullName || '').trim();
  const phone = String(customer.phone || '').replace(/\D/g, '');
  const email = String(customer.email || '').trim();

  if (!fullName) throw new Error('חסר שם מלא.');
  if (!/^0\d{8,9}$/.test(phone)) throw new Error('מספר הטלפון אינו תקין.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('כתובת המייל אינה תקינה.');

  let fulfillment = String(payload.fulfillment || '').trim();
  if (fulfillment === 'איסוף') fulfillment = 'איסוף עצמי';
  if (fulfillment !== 'איסוף עצמי' && fulfillment !== 'משלוח') throw new Error('יש לבחור שיטת הזמנה.');

  if (fulfillment === 'משלוח') {
    if (!String(delivery.address || '').trim()) throw new Error('חסרה כתובת למשלוח.');
    if (!String(delivery.floor || '').trim()) throw new Error('חסרה קומה למשלוח.');
  }

  if (!Array.isArray(items) || items.length === 0) throw new Error('לא נבחרו מוצרים להזמנה.');

  const normalizedItems = [];

  items.forEach(item => {
    const product = productMap[item.id];
    if (!product) throw new Error('אחד המוצרים אינו קיים יותר בקטלוג. יש לרענן ולנסות שוב.');

    const quantity = Number(item.quantity);
    const note = getItemNote(item);
    let mode = String(item.mode || '').trim();
    if (!quantity || quantity <= 0) return;

    if (product.unitType === 'unit') mode = 'unit';
    if (product.unitType === 'kg' && mode !== 'kg' && mode !== 'unit') {
      throw new Error('בחירת יחידת הזמנה לא תקינה עבור ' + product.name + '.');
    }
    if (product.unitType !== 'kg' && mode !== 'unit') mode = 'unit';

    if (mode === 'unit' && !isWholeNumber(quantity)) {
      throw new Error('במוצר ' + product.name + ' יש להזין יחידות במספר שלם.');
    }
    if (mode === 'kg' && !isHalfStep(quantity)) {
      throw new Error('במוצר ' + product.name + ' יש להזין משקל במספר שלם או חצי.');
    }

    const orderUnit = mode === 'kg' ? 'ק״ג' : 'יחידות';
    let lineTotal = '';
    if (canCalculateLineTotal(mode, product.priceUnit)) {
      lineTotal = roundMoney(quantity * product.price);
    }

    normalizedItems.push({ product, mode, quantity, orderUnit, lineTotal, note });
  });

  if (normalizedItems.length === 0) throw new Error('לא נבחרו מוצרים להזמנה.');

  const estimatedTotal = roundMoney(
    normalizedItems.reduce((sum, line) => typeof line.lineTotal === 'number' ? sum + line.lineTotal : sum, 0)
  );
  const unpricedItemCount = normalizedItems.filter(l => typeof l.lineTotal !== 'number').length;

  return {
    orderId: generateOrderId(),
    fullName,
    phone,
    email,
    fulfillment,
    address: String(delivery.address || '').trim(),
    floor: String(delivery.floor || '').trim(),
    apartment: String(delivery.apartment || '').trim(),
    notes,
    items: normalizedItems,
    estimatedTotal,
    unpricedItemCount,
  };
}

function getItemNote(item) {
  const candidates = [
    item && item.note,
    item && item.notes,
    item && item.itemNote,
    item && item.productNote,
    item && item.product_notes,
  ];

  for (const value of candidates) {
    const note = String(value || '').trim();
    if (note) return note.slice(0, 300);
  }

  return '';
}

async function writeOrder(order) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const now = new Date().toISOString();

  await Promise.all([
    ensureSheetHeaders(sheets, spreadsheetId, ORDERS_SHEET, ORDER_HEADERS),
    ensureSheetHeaders(sheets, spreadsheetId, ORDER_ITEMS_SHEET, ORDER_ITEM_HEADERS),
  ]);

  const initialCustomerEmailStatus = order.email ? VERCEL_IN_PROGRESS_STATUS : 'לא נמסר מייל';
  const initialBusinessEmailStatus = order.settings && order.settings.notificationEmails
    ? VERCEL_IN_PROGRESS_STATUS
    : 'לא הוגדר מייל';
  const initialTelegramStatus = order.settings && order.settings.telegramBotToken && order.settings.telegramChatId
    ? VERCEL_IN_PROGRESS_STATUS
    : 'לא הוגדר טלגרם';

  const orderRow = [
    now,
    order.orderId,
    PRODUCTS_SHEET,
    order.fullName,
    order.phone,
    order.fulfillment,
    order.address,
    order.floor,
    order.apartment,
    order.notes,
    order.items.length,
    'חדש',
    order.estimatedTotal,
    order.unpricedItemCount,
    order.email,
    initialCustomerEmailStatus,
    '',
    initialBusinessEmailStatus,
    '',
    initialTelegramStatus,
    '',
  ];

  const itemRows = order.items.map(line => [
    now,
    order.orderId,
    line.product.name,
    line.product.department,
    line.mode === 'kg' ? 'משקל' : 'יחידות',
    line.quantity,
    line.orderUnit,
    line.product.price,
    line.product.priceUnit || line.product.unit,
    typeof line.lineTotal === 'number' ? line.lineTotal : '',
    line.note,
  ]);

  const orderAppend = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: ORDERS_SHEET + '!A:' + columnLetter(ORDER_HEADERS.length),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [orderRow] },
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: ORDER_ITEMS_SHEET + '!A:' + columnLetter(ORDER_ITEM_HEADERS.length),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: itemRows },
  });

  return {
    rowNumber: parseUpdatedRangeRowNumber(orderAppend.data && orderAppend.data.updates && orderAppend.data.updates.updatedRange),
    timestamp: now,
  };
}

async function appendPickingOrder(order, items) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  await ensurePickingSheet(sheets, spreadsheetId);

  if (await pickingSheetHasOrder(sheets, spreadsheetId, order.orderId)) {
    return { skipped: true };
  }

  const rows = buildPickingRows(order, items);
  const existingRows = await getPickingValues(sheets, spreadsheetId);
  const startRow = Math.max(existingRows.length + 2, 3);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: PICKING_SHEET + '!A' + startRow + ':F' + (startRow + rows.length - 1),
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  return { skipped: false, rowCount: rows.length };
}

async function updateOrderNotificationStatuses(orderId, rowNumber, results) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const targetRow = rowNumber || await findOrderRowNumber(sheets, spreadsheetId, orderId);

  if (!targetRow) {
    throw new Error('לא נמצאה שורת הזמנה לעדכון סטטוס התראות.');
  }

  const customer = normalizeStatusResult(results && results.customerEmail);
  const business = normalizeStatusResult(results && results.businessEmail);
  const telegram = normalizeStatusResult(results && results.telegram);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: ORDERS_SHEET + '!P' + targetRow + ':U' + targetRow,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        customer.status,
        customer.error,
        business.status,
        business.error,
        telegram.status,
        telegram.error,
      ]],
    },
  });
}

function normalizeStatusResult(result) {
  return {
    status: String(result && result.status || ''),
    error: truncateCell(String(result && result.error || '')),
  };
}

function truncateCell(value) {
  return String(value || '').slice(0, 2000);
}

function parseUpdatedRangeRowNumber(range) {
  const match = String(range || '').match(/![A-Z]+(\d+):/);
  return match ? Number(match[1]) : null;
}

async function findOrderRowNumber(sheets, spreadsheetId, orderId) {
  if (!orderId) return null;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: ORDERS_SHEET + '!B:B',
  }).catch(() => ({ data: { values: [] } }));
  const values = response.data.values || [];

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === orderId) {
      return i + 1;
    }
  }

  return null;
}

async function ensurePickingSheet(sheets, spreadsheetId) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });
  const exists = (metadata.data.sheets || []).some(sheet => sheet.properties && sheet.properties.title === PICKING_SHEET);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: PICKING_SHEET,
                rightToLeft: true,
              },
            },
          },
        ],
      },
    });
  }

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: PICKING_SHEET + '!A1:F1',
  }).catch(() => ({ data: { values: [] } }));
  const firstRow = response.data.values && response.data.values[0] || [];

  if (!String(firstRow[0] || '').trim()) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: PICKING_SHEET + '!A1:F1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['דפי ליקוט להזמנות', '', '', '', '', '']] },
    });
  }
}

async function getPickingValues(sheets, spreadsheetId) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: PICKING_SHEET + '!A:F',
  }).catch(() => ({ data: { values: [] } }));

  return response.data.values || [];
}

async function pickingSheetHasOrder(sheets, spreadsheetId, orderId) {
  if (!orderId) return false;

  const values = await getPickingValues(sheets, spreadsheetId);

  return values.some(row => row.some(cell => String(cell || '').trim() === orderId));
}

function buildPickingRows(order, items) {
  const addressText = buildAddressText(order);
  const totalText = formatEstimatedTotal(order.estimatedTotal, order.unpricedItemCount);
  const rows = [
    ['מספר הזמנה', order.orderId, 'לקוח', order.fullName, 'טלפון', order.phone],
    ['שיטת הזמנה', order.fulfillment, 'כתובת/איסוף', addressText, 'סכום משוער', totalText],
    ['הערות', order.notes || '', '', '', '', ''],
    ['מוצר', 'מחלקה', 'כמות', 'יחידה', 'מחיר', 'סכום'],
  ];

  items.forEach(line => {
    const productText = line.note
      ? line.product.name + '\nהערה: ' + line.note
      : line.product.name;

    rows.push([
      productText,
      line.product.department,
      formatQuantity(line.quantity),
      line.orderUnit,
      formatMoney(line.product.price) + ' / ' + (line.product.priceUnit || ''),
      typeof line.lineTotal === 'number' ? formatMoney(line.lineTotal) : 'לפי חישוב בפועל',
    ]);
  });

  return rows;
}

function buildAddressText(order) {
  if (order.fulfillment !== 'משלוח') {
    return 'איסוף עצמי';
  }

  const parts = [order.address];

  if (order.floor) parts.push('קומה ' + order.floor);
  if (order.apartment) parts.push('דירה ' + order.apartment);

  return parts.filter(Boolean).join(', ');
}

function formatEstimatedTotal(total, unpricedItemCount) {
  const base = formatMoney(total || 0);

  if (Number(unpricedItemCount || 0) > 0) {
    return base + ' + ' + unpricedItemCount + ' פריטים לפי חישוב בפועל';
  }

  return base;
}

function formatQuantity(value) {
  const number = Number(value || 0);

  if (Math.abs(number - Math.round(number)) < 0.000001) {
    return String(Math.round(number));
  }

  return String(number).replace(/0+$/, '').replace(/\.$/, '');
}

function formatMoney(value) {
  return '₪' + formatQuantity(Math.round(Number(value || 0) * 100) / 100);
}

async function ensureSheetHeaders(sheets, spreadsheetId, sheetName, headers) {
  const endColumn = columnLetter(headers.length);
  const range = sheetName + '!A1:' + endColumn + '1';
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  }).catch(() => ({ data: { values: [] } }));
  const current = (response.data.values && response.data.values[0] || []).slice();
  let changed = false;

  for (let i = 0; i < headers.length; i++) {
    if (!String(current[i] || '').trim()) {
      current[i] = headers[i];
      changed = true;
    }
  }

  if (!changed) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [current] },
  });
}

function columnLetter(index) {
  let n = index;
  let result = '';

  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }

  return result;
}

async function readCatalog() {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  const [productsRes, settingsRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: PRODUCTS_SHEET }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: SETTINGS_SHEET }).catch(() => ({ data: { values: [] } })),
  ]);

  const settings = parseSettings(settingsRes.data.values || []);
  const products = parseProducts(productsRes.data.values || []);
  const categories = groupProducts(products);

  return { settings, products, categories };
}

module.exports = {
  readCatalog,
  parseSettings,
  parseProducts,
  validateAndBuildOrder,
  writeOrder,
  appendPickingOrder,
  updateOrderNotificationStatuses,
  getSpreadsheetId,
};
