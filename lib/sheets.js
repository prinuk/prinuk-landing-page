const { google } = require('googleapis');
const crypto = require('crypto');

const CATEGORY_ORDER = ['ירקות', 'פירות', 'עלים', 'מיוחדים', 'יינות ואלכוהול'];

const DEFAULTS = {
  title: 'פרינוּק - המכירה השבועית',
  description: '',
  closedMessage: 'ההזמנות עוד לא נפתחו. הטופס ייפתח בקרוב.',
  pickupText: 'המכירה תתקיים ביום שלישי ברחוב הפסגה 63 בין השעות 10:00-19:00',
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
  'סטטוס מייל פרינוּק', 'שגיאת מייל פרינוּק',
  'סטטוס טלגרם פרינוּק', 'שגיאת טלגרם פרינוּק',
  // New columns MUST stay AFTER the notification-status block (P:U) above,
  // because updateOrderNotificationStatuses writes a fixed P:U range.
  'טוקן עריכה', 'עודכן בתאריך',
  // Team-dashboard picking columns (X:Y). Written by updateOrderCollection /
  // claimOrderForPicking; left blank by writeOrder/updateOrderInPlace.
  'נאסף על ידי', 'זמן ליקוט',
];

// Status value a brand-new order starts with; an order is editable by the
// customer only while it still has this status (and orders are open).
const ORDER_STATUS_NEW = 'חדש';
// Team-dashboard picking statuses. Any status other than 'חדש' locks the order
// from further customer edits (see readOrderForEdit), which is the desired
// behaviour once the team starts handling it.
const ORDER_STATUS_PICKING = 'בליקוט';
const ORDER_STATUS_COLLECTED = 'נאסף';
const ORDER_STATUS_PARTIAL = 'נאסף חלקית';
// Terminal statuses set manually from the team dashboard once a collected order
// has left: 'נשלח' for delivery orders, 'נמסר' for self-pickup (handed to the
// customer).
const ORDER_STATUS_SENT = 'נשלח';
const ORDER_STATUS_HANDED = 'נמסר';
// Per-item picking states stored in the order-items sheet (col L).
const ITEM_PICK_COLLECTED = 'נאסף';
const ITEM_PICK_MISSING = 'חסר';

const ORDER_ITEM_HEADERS = [
  'זמן', 'מספר הזמנה', 'מוצר', 'מחלקה', 'שיטת כמות',
  'כמות', 'יחידת הזמנה', 'מחיר מהגיליון', 'יחידת מחיר', 'סכום מחושב',
  'הערת מוצר',
  // Team-dashboard per-item picking state (col L): 'נאסף' / 'חסר' / ''.
  'סטטוס ליקוט',
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

// The full settings object with default values (the same shape parseSettings
// returns). Shared with the Postgres store so both stay in sync.
function defaultSettings() {
  return {
    title: DEFAULTS.title,
    description: DEFAULTS.description,
    closedMessage: DEFAULTS.closedMessage,
    saleName: '',
    // Explicit open/closed switch for the sale (Postgres era). 'open' by default
    // for backward compatibility (when closed, readCatalog returns no products).
    saleStatus: 'open',
    pickupText: DEFAULTS.pickupText,
    logoUrl: '',
    notificationEmails: '',
    telegramBotToken: '',
    telegramChatId: '',
    // Optional second channel: collected/picked-order summaries (same bot token).
    telegramPickedChatId: '',
    // Time-limited items ("ניתן להזמין עד …"): the time shown to customers vs the
    // real time after which ordering is disabled (HH:MM, Israel time).
    orderCutoffDisplayTime: '03:00',
    orderCutoffEnforceTime: '06:00',
    contactPhone: DEFAULTS.contactPhone,
    contactEmail: DEFAULTS.contactEmail,
  };
}

function parseSettings(rows) {
  const settings = defaultSettings();

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
    'טלגרם ערוץ ליקוט': 'telegramPickedChatId',
    'Telegram picked chat ID': 'telegramPickedChatId',
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
  const map = { name: 0, department: 1, unit: 2, priceUnit: null, price: 3, active: null, weight: null, image: null };

  headers.forEach((header, index) => {
    const v = normalizeHeader(header);
    if (!v) return;

    if (v === 'שם' || v === 'שם מוצר' || v === 'מוצר' || v === 'name' || v === 'product') {
      map.name = index;
    } else if (v.includes('תמונה') || v.includes('תמונת') || v.includes('image') || v.includes('photo')) {
      map.image = index;
    } else if (v.includes('משקל') || v.includes('weight')) {
      map.weight = index;
    } else if (v.includes('מחלקה') || v.includes('קטגוריה') || v === 'department' || v === 'category') {
      map.department = index;
    } else if ((v.includes('יחידת') && v.includes('מחיר')) || v === 'יחידת מחיר' || v === 'price unit') {
      map.priceUnit = index;
    } else if (v.includes('יחידת') || v === 'יחידה' || v === 'unit') {
      map.unit = index;
    } else if (v.includes('מחיר') || v === 'price') {
      map.price = index;
    } else if (v.includes('פעיל') || v.includes('זמין') || v.includes('מלאי') || v === 'סטטוס' || v === 'status' || v === 'active' || v === 'available') {
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

// Out of stock: the product stays visible in the catalog but can't be ordered.
function isOutOfStock(value) {
  if (value === '' || value === null || value === undefined || value === true || value === false) {
    return false;
  }
  const text = String(value).trim().replace(/[״"]/g, '"').replace(/\s+/g, ' ').toLowerCase();
  return [
    'אזל', 'אזל מהמלאי', 'אזל מלאי', 'אין במלאי', 'אין מלאי', 'נגמר', 'נגמר המלאי',
    'out of stock', 'sold out', 'oos',
  ].includes(text);
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
    const statusCell = columns.active === null ? '' : row[columns.active];
    const outOfStock = isOutOfStock(statusCell);
    // Out-of-stock rows stay visible; only truly inactive rows are dropped.
    const active = outOfStock ? true : (columns.active === null ? true : isActive(statusCell));

    if (!name || !active || !price || price <= 0) continue;

    // Per-product overrides from the sheet, falling back to the name-keyed maps.
    const columnWeight = columns.weight === null ? 0 : parsePrice(row[columns.weight]);
    const columnImage = columns.image === null ? '' : String(row[columns.image] || '').trim();

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
      estimatedUnitWeightKg: (columnWeight > 0 ? columnWeight : getEstimatedUnitWeightKg(name)) || null,
      imageUrl: columnImage || getProductImageUrl(name),
      outOfStock,
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
function roundMoney(v) { return Math.round(v * 100) / 100; }
function roundWeight(v) { return Math.round(v * 1000) / 1000; }

// "X for Y" quantity deal for unit-priced items: every full group of `dealQty`
// units costs `dealPrice`, the remainder is charged at the regular `unitPrice`.
// (e.g. שום בשרוול: ₪4/unit, every 3 = ₪10 → 4 units = ₪14.) Works in whatever
// currency unit the caller passes (shekels here; agorot in lib/store.js).
function applyUnitDeal(quantity, unitPrice, dealQty, dealPrice) {
  const q = Number(quantity) || 0;
  const dq = Number(dealQty) || 0;
  const dp = Number(dealPrice);
  const up = Number(unitPrice) || 0;
  if (dq > 0 && isFinite(dp) && dp >= 0) {
    const groups = Math.floor(q / dq);
    const remainder = q - groups * dq;
    return groups * dp + remainder * up;
  }
  return q * up;
}

const UNIT_WEIGHT_ESTIMATES_KG = {
  'תפוא לבן שק (כ4 קג)': 4,
  'תפוא לבן תפזורת': 0.25,
  'תפוא לבן (תפזורת)': 0.25,
  'תפוא אדום מיוחד דוד משה שק (כ1.7 קג)': 1.7,
  'תפוא אדום שק (כ4 קג)': 4,
  'תפוא אדום (תפזורת)': 0.25,
  'תפוא אדום': 0.25,
  'תפוא גורמה בייבי (מארז)': 1.5,
  'בצל לבן': 0.2,
  'בצל אדום': 0.2,
  'מלפפון': 0.15,
  'עגבניה איכותית': 0.15,
  'עגבניה לבישול': 0.15,
  'עגבניות שרי אדום (סלסלה)': 1.2,
  'עגבניות שרי צהוב (סלסלה)': 1.2,
  'עגבניות שרי כתום (סלסלה)': 1.2,
  'פלפל אדום': 0.17,
  'פלפל צהוב': 0.17,
  'פלפל חריף': 0.07,
  'קישואים': 0.18,
  'זוקיני': 0.1,
  'גזר (מארז)': 1.3,
  'מארז גזר צבעוני': 1.3,
  'קולורבי': 0.3,
  'חציל': 0.4,
  'חציל בלאדי': 0.7,
  'בטטה': 0.3,
  'סלק': 0.4,
  'לימון': 0.15,
  'אבוקדו': 0.3,
  'תפוח פינק ליידי': 0.23,
  'תפוח סמיט': 0.25,
  'תפוח צהוב': 0.25,
  'תפוח אדום': 0.25,
  'אגס': 0.15,
  'שסק (סלסלה)': 1,
  'משמש': 0.1,
  'אפרסק': 0.15,
  'נקטרינה': 0.2,
  'שזיף': 0.2,
  'קווי חול מיוחד': 0.15,
  'קיווי חול מיוחד': 0.15,
  'ענב ירוק חול': 1,
  'ענב ירוק חול (שקית)': 1,
  'ענב ירוק (סלסלה)': 1,
  'ענב ירוק טלי (סלסלה)': 1,
  'ענב אדום (סלסלה)': 1,
  'ענב אדום טלי (סלסלה)': 1,
  'תפוז': 0.35,
  'בננה': 0.2,
  'אבטיח': 8,
  'חצי - אבטיח': 4,
  'אבטיח - חצי': 4,
  'מלון': 1.5,
  'כרוב אדום': 1,
  'כרוב אדום מהדרין - ללא חרקים': 1.2,
  'כרוב לבן': 1,
  'כרוב לבן מהדרין - ללא חרקים': 1.2,
  'כרוב לבן מהדרין ללא חרקים': 1.2,
  'שומר': 0.25,
  'לוף': 0.4,
  'לוף (כרישה)': 0.4,
  'קלמנטינה': 0.22
};

const PRODUCT_IMAGE_CANDIDATES = [
  { url: '/assets/produce/gourmet-baby-potatoes.jpg', names: ['תפוא בייבי גורמה', 'תפוח אדמה בייבי גורמה', 'תפוא גורמה בייבי'] },
  { url: '/assets/produce/potato-red-david-moshe.jpg', names: ['תפוא אדום מיוחד דוד משה', 'תפוא אדום דוד משה', 'תפוח אדמה אדום דוד משה'] },
  { url: '/assets/produce/potato-white.jpg', names: ['תפוא לבן', 'תפוח אדמה לבן'] },
  { url: '/assets/produce/potato-red.jpg', names: ['תפוא אדום', 'תפוח אדמה אדום'] },
  { url: '/assets/produce/apple-granny-smith.jpg', names: ['תפוח סמיט', 'תפוע סמיט', 'סמיט'] },
  { url: '/assets/produce/apple-pink-lady.jpg', names: ['תפוח פינק ליידי', 'תפוע פינק ליידי', 'פינק ליידי'] },
  { url: '/assets/produce/apple-yellow.jpg', names: ['תפוח צהוב', 'תפוע צהוב'] },
  { url: '/assets/produce/apple-red.jpg', names: ['תפוח אדום', 'תפוע אדום'] },
  { url: '/assets/produce/peach.jpg', names: ['אפרסק'] },
  { url: '/assets/produce/apricot.jpg', names: ['משמש'] },
  { url: '/assets/produce/nectarine.jpg', names: ['נקטרינה'] },
  { url: '/assets/produce/plum-watermelon.jpg', names: ['שזיף אבטיח'] },
  { url: '/assets/produce/plum.jpg', names: ['שזיף'] },
  { url: '/assets/produce/loquat.jpg', names: ['שסק'] },
  { url: '/assets/produce/pear.jpg', names: ['אגס'] },
  { url: '/assets/produce/kiwi.jpg', names: ['קיווי'] },
  { url: '/assets/produce/green-grapes-imported.jpg', names: ['ענב ירוק חו״ל', 'ענב ירוק חו"ל', 'ענב ירוק חול'] },
  { url: '/assets/produce/green-grapes.jpg', names: ['ענב ירוק', 'ענבים ירוקים'] },
  { url: '/assets/produce/red-grapes.jpg', names: ['ענב אדום', 'ענבים אדומים'] },
  { url: '/assets/produce/orange.jpg', names: ['תפוז'] },
  { url: '/assets/produce/banana.jpg', names: ['בננה'] },
  { url: '/assets/produce/watermelon.jpg', names: ['אבטיח'] },
  { url: '/assets/produce/melon.jpg', names: ['מלון'] },
  { url: '/assets/produce/cherries.jpg', names: ['דובדבן', 'דובדבנים'] },
  { url: '/assets/produce/mango.jpg', names: ['מנגו'] },
  { url: '/assets/produce/pineapple.jpg', names: ['אננס'] },
  { url: '/assets/produce/pomegranate.jpg', names: ['רימון', 'רימונים'] },
  { url: '/assets/produce/clementine.jpg', names: ['קלמנטינה', 'קלמנטינות'] },
  { url: '/assets/produce/dates.jpg', names: ['תמר', 'תמרים', 'תמר מג׳הול', 'תמרים מג׳הול', 'מג׳הול'] },
  { url: '/assets/produce/white-onion.jpg', names: ['בצל לבן', 'בצל יבש'] },
  { url: '/assets/produce/red-onion.jpg', names: ['בצל אדום'] },
  { url: '/assets/produce/shallots.jpg', names: ['בצלצלי שאלוט', 'בצל שאלוט', 'שאלוט'] },
  { url: '/assets/produce/mini-cucumber-pack.jpg', names: ['מארז מלפפון מיני', 'מלפפון מיני'] },
  { url: '/assets/produce/cucumber.jpg', names: ['מלפפון'] },
  { url: '/assets/produce/tomato.jpg', names: ['עגבניה', 'עגבניות'] },
  { url: '/assets/produce/cherry-tomatoes-red.jpg', names: ['שרי אדום', 'עגבניות שרי אדום', 'עגבניות שרי תמר'] },
  { url: '/assets/produce/cherry-tomatoes-orange.jpg', names: ['שרי כתום', 'עגבניות שרי כתום'] },
  { url: '/assets/produce/cherry-tomatoes-yellow.jpg', names: ['שרי צהוב', 'עגבניות שרי צהוב'] },
  { url: '/assets/produce/red-pepper.jpg', names: ['פלפל אדום'] },
  { url: '/assets/produce/yellow-pepper.jpg', names: ['פלפל צהוב'] },
  { url: '/assets/produce/mini-peppers-pack.jpg', names: ['מארז פלפלונים', 'מארז פלפולנים', 'פלפלונים'] },
  { url: '/assets/produce/jalapeno-pepper.jpg', names: ['פלפל חלפיניו', 'חלפיניו', 'חלפניו'] },
  { url: '/assets/produce/chili-pepper.jpg', names: ['פלפל צ׳ילי', 'פלפל צילי', 'צ׳ילי', 'צילי'] },
  { url: '/assets/produce/habanero-pepper.jpg', names: ['פלפל הבנרו חריף אש', 'פלפל הבנרו', 'הבנרו'] },
  { url: '/assets/produce/hot-pepper.jpg', names: ['פלפל חריף'] },
  { url: '/assets/produce/shushka-pepper.jpg', names: ['פלפל שושקה', 'שושקה'] },
  { url: '/assets/produce/squash.jpg', names: ['קישוא', 'קישואים'] },
  { url: '/assets/produce/zucchini.jpg', names: ['זוקיני'] },
  { url: '/assets/produce/carrot.jpg', names: ['גזר'] },
  { url: '/assets/produce/rainbow-carrots-pack.jpg', names: ['מארז גזר צבעוני', 'גזר צבעוני'] },
  { url: '/assets/produce/kohlrabi.jpeg', names: ['קולורבי'] },
  { url: '/assets/produce/baladi-eggplant.jpg', names: ['חציל בלאדי', 'חציל בלדי'] },
  { url: '/assets/produce/mini-eggplants.jpg', names: ['חצילונים'] },
  { url: '/assets/produce/eggplant.jpg', names: ['חציל'] },
  { url: '/assets/produce/sweet-potato.jpg', names: ['בטטה'] },
  { url: '/assets/produce/vacuum-beet.jpg', names: ['סלק בוואקום', 'סלק וואקום'] },
  { url: '/assets/produce/beet.jpg', names: ['סלק'] },
  { url: '/assets/produce/radishes.jpg', names: ['צנוניות', 'צנונית'] },
  { url: '/assets/produce/lemon.jpg', names: ['לימון'] },
  { url: '/assets/produce/avocado.jpg', names: ['אבוקדו'] },
  { url: '/assets/produce/red-cabbage.jpg', names: ['כרוב אדום'] },
  { url: '/assets/produce/white-cabbage.jpg', names: ['כרוב לבן'] },
  { url: '/assets/produce/lettuce-hearts.jpg', names: ['לבבות חסה'] },
  { url: '/assets/produce/lettuce-lalik.jpg', names: ['חסה לאליק'] },
  { url: '/assets/produce/lettuce.jpg', names: ['חסה'] },
  { url: '/assets/produce/cilantro.jpg', names: ['כוסברה'] },
  { url: '/assets/produce/parsley.jpg', names: ['פטרוזיליה'] },
  { url: '/assets/produce/dill.jpg', names: ['שמיר'] },
  { url: '/assets/produce/mint.jpg', names: ['נענע'] },
  { url: '/assets/produce/basil.jpg', names: ['בזיליקום'] },
  { url: '/assets/produce/celery.jpg', names: ['סלרי'] },
  { url: '/assets/produce/celery-root.jpg', names: ['ראש סלרי', 'שורש סלרי'] },
  { url: '/assets/produce/fennel.jpg', names: ['שומר'] },
  { url: '/assets/produce/leek.jpg', names: ['לוף', 'כרישה'] },
  { url: '/assets/produce/green-onion.jpg', names: ['בצל ירוק'] },
  { url: '/assets/produce/garlic.jpg', names: ['שום יבש', 'שום'] },
  { url: '/assets/produce/peeled-garlic.jpg', names: ['שום קלוף'] },
  { url: '/assets/produce/mushrooms.jpg', names: ['פטריות', 'פטריה'] },
  { url: '/assets/produce/baby-leaves.jpg', names: ['עלי בייבי', 'מיקס עלי בייבי'] },
  { url: '/assets/produce/beet-leaves.jpg', names: ['עלי סלק'] },
  { url: '/assets/produce/endive-red.jpg', names: ['אנדיב (עולש) אדום', 'אנדיב עולש אדום', 'אנדיב אדום'] },
  { url: '/assets/produce/endive.jpg', names: ['אנדיב'] },
  { url: '/assets/produce/thyme.jpg', names: ['טימין'] },
  { url: '/assets/produce/rosemary.jpg', names: ['רוזמרין'] },
  { url: '/assets/produce/ginger.jpg', names: ['ג׳ינג׳ר', 'גינגר', 'גינג׳ר', 'זנגביל'] },
  { url: '/assets/produce/sunflower-sprouts.jpg', names: ['נבטי חמניה', 'נבטי חמנייה'] },
  { url: '/assets/produce/thick-sprouts.jpg', names: ['נבטים עבים'] },
];
const IMAGE_MATCH_STOP_WORDS = new Set([
  'איכותית',
  'לבישול',
  'מיוחד',
  'מיוחדת',
  'חול',
  'ארוז',
  'מארז',
  'סלסלה',
  'תפזורת',
  'שק',
  'קג',
  'כ4',
  'כ17',
]);

function normalizeProductName(value) {
  return String(value || '')
    .trim()
    .replace(/[״"]/g, '')
    .replace(/[׳']/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function getEstimatedUnitWeightKg(productName) {
  return UNIT_WEIGHT_ESTIMATES_KG[normalizeProductName(productName)] || 0;
}

function getProductImageUrl(productName) {
  const productText = normalizeProductName(productName);
  const productTokens = tokenizeProductName(productName);
  let best = { score: 0, url: '' };

  PRODUCT_IMAGE_CANDIDATES.forEach(candidate => {
    candidate.names.forEach(alias => {
      const aliasText = normalizeProductName(alias);
      const aliasTokens = tokenizeProductName(alias);
      const matchedTokens = aliasTokens.filter(token => productTokens.includes(token)).length;
      let score = 0;

      if (productText === aliasText) {
        score = 1000 + aliasTokens.length;
      } else if (productText.includes(aliasText)) {
        score = 800 + aliasTokens.length;
      } else if (aliasText.includes(productText)) {
        score = 700 + productTokens.length;
      } else if (aliasTokens.length && matchedTokens === aliasTokens.length) {
        score = 600 + matchedTokens;
      } else if (aliasTokens.length === 1 && matchedTokens === 1) {
        score = 300;
      }

      if (score > best.score) {
        best = { score, url: candidate.url };
      }
    });
  });

  return best.score >= 300 ? best.url : '';
}

function tokenizeProductName(value) {
  return normalizeProductName(value)
    .replace(/[^0-9A-Za-z\u0590-\u05FF]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => !IMAGE_MATCH_STOP_WORDS.has(token));
}

function calculateLineTotal(mode, quantity, product) {
  const priceUnit = product.priceUnit || product.unit;
  const priceUnitType = getUnitType(priceUnit);

  if (mode === 'kg' && priceUnitType === 'kg') {
    return {
      lineTotal: roundMoney(quantity * product.price),
      estimatedWeightKg: null,
      estimatedWeightPerUnitKg: null,
      isEstimatedPriceTotal: true,
      isEstimatedWeightTotal: false,
    };
  }

  if (mode === 'unit' && priceUnitType === 'unit') {
    return {
      lineTotal: roundMoney(applyUnitDeal(quantity, product.price, product.dealQty, product.dealPrice)),
      estimatedWeightKg: null,
      estimatedWeightPerUnitKg: null,
      isEstimatedPriceTotal: false,
      isEstimatedWeightTotal: false,
    };
  }

  if (mode === 'unit' && priceUnitType === 'kg') {
    const estimatedWeightPerUnitKg = Number(product.estimatedUnitWeightKg || getEstimatedUnitWeightKg(product.name) || 0);

    if (estimatedWeightPerUnitKg) {
      const estimatedWeightKg = roundWeight(quantity * estimatedWeightPerUnitKg);

      return {
        lineTotal: roundMoney(estimatedWeightKg * product.price),
        estimatedWeightKg,
        estimatedWeightPerUnitKg,
        isEstimatedPriceTotal: true,
        isEstimatedWeightTotal: true,
      };
    }
  }

  return {
    lineTotal: '',
    estimatedWeightKg: null,
    estimatedWeightPerUnitKg: null,
    isEstimatedPriceTotal: priceUnitType === 'kg',
    isEstimatedWeightTotal: false,
  };
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

// Per-order secret used to authorize the emailed "edit your order" link
// without requiring a customer login.
function generateEditToken() {
  return crypto.randomBytes(16).toString('hex');
}

function normalizeCustomerPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');

  if (digits.indexOf('9725') === 0 && digits.length === 12) {
    return '0' + digits.slice(3);
  }

  return digits;
}

function isValidCustomerPhone(phone) {
  return /^05\d{8}$/.test(phone);
}

// Delivery is offered only to these Jerusalem neighborhoods. Keep this list in
// sync with the neighborhood <select> in order/index.html.
const DELIVERY_NEIGHBORHOODS = ['בית וגן', 'בית הכרם', 'קריית יובל', 'רמת שרת', 'רמת דניה'];
const FREE_DELIVERY_THRESHOLD = 200;
const DELIVERY_FEE = 25;

function validateAndBuildOrder(payload, products) {
  const productMap = {};
  products.forEach(p => { productMap[p.id] = p; });

  const customer = payload.customer || {};
  const delivery = payload.delivery || {};
  const neighborhood = String(delivery.neighborhood || '').trim();
  const items = payload.items || [];
  const notes = String(payload.notes || '').trim();

  const fullName = String(customer.fullName || '').trim();
  const phone = normalizeCustomerPhone(customer.phone);
  const email = String(customer.email || '').trim();

  if (!fullName) throw new Error('חסר שם מלא.');
  if (!isValidCustomerPhone(phone)) throw new Error('מספר הטלפון הנייד אינו תקין. הזינו מספר שמתחיל ב-05 ובו 10 ספרות.');
  if (!email) throw new Error('יש למלא כתובת מייל.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('כתובת המייל אינה תקינה.');

  let fulfillment = String(payload.fulfillment || '').trim();
  if (fulfillment === 'איסוף') fulfillment = 'איסוף עצמי';
  if (fulfillment !== 'איסוף עצמי' && fulfillment !== 'משלוח') throw new Error('יש לבחור שיטת הזמנה.');

  if (fulfillment === 'משלוח') {
    if (!DELIVERY_NEIGHBORHOODS.includes(neighborhood)) {
      throw new Error('משלוח זמין לשכונות: ' + DELIVERY_NEIGHBORHOODS.join(', ') + '. לשאר האזורים ניתן לבחור איסוף עצמי.');
    }
    if (!String(delivery.address || '').trim()) throw new Error('חסרה כתובת למשלוח.');
    if (!String(delivery.floor || '').trim()) throw new Error('חסרה קומה למשלוח.');
  }

  if (!Array.isArray(items) || items.length === 0) throw new Error('לא נבחרו מוצרים להזמנה.');

  const normalizedItems = [];

  items.forEach(item => {
    const product = productMap[item.id];
    if (!product) throw new Error('אחד המוצרים אינו קיים יותר בקטלוג. יש לרענן ולנסות שוב.');
    if (product.outOfStock) throw new Error('המוצר ' + product.name + ' אזל מהמלאי. יש לרענן ולנסות שוב.');

    const quantity = Number(item.quantity);
    const note = getItemNote(item, payload);
    // Orders are always in whole units (kg ordering has been removed).
    const mode = 'unit';
    if (!quantity || quantity <= 0) return;

    if (mode === 'unit' && !isWholeNumber(quantity)) {
      throw new Error('במוצר ' + product.name + ' יש להזין יחידות במספר שלם.');
    }

    const orderUnit = mode === 'kg' ? 'ק"ג' : 'יחידות';
    const lineEstimate = calculateLineTotal(mode, quantity, product);

    normalizedItems.push({
      product,
      mode,
      quantity,
      orderUnit,
      lineTotal: lineEstimate.lineTotal,
      estimatedWeightKg: lineEstimate.estimatedWeightKg,
      estimatedWeightPerUnitKg: lineEstimate.estimatedWeightPerUnitKg,
      isEstimatedPriceTotal: lineEstimate.isEstimatedPriceTotal,
      isEstimatedWeightTotal: lineEstimate.isEstimatedWeightTotal,
      note,
    });
  });

  if (normalizedItems.length === 0) throw new Error('לא נבחרו מוצרים להזמנה.');

  const estimatedTotal = roundMoney(
    normalizedItems.reduce((sum, line) => typeof line.lineTotal === 'number' ? sum + line.lineTotal : sum, 0)
  );
  const unpricedItemCount = normalizedItems.filter(l => typeof l.lineTotal !== 'number').length;
  const estimatedWeightItemCount = normalizedItems.filter(l => l.isEstimatedWeightTotal).length;

  // ₪25 delivery under the free threshold, free at/above it, none for pickup.
  const deliveryFee = fulfillment === 'משלוח' && estimatedTotal < FREE_DELIVERY_THRESHOLD ? DELIVERY_FEE : 0;
  const grandTotal = roundMoney(estimatedTotal + deliveryFee);

  const street = String(delivery.address || '').trim();
  const composedAddress = fulfillment === 'משלוח' && neighborhood
    ? (street ? neighborhood + ', ' + street : neighborhood)
    : street;

  return {
    orderId: generateOrderId(),
    editToken: generateEditToken(),
    fullName,
    phone,
    email,
    fulfillment,
    neighborhood,
    address: composedAddress,
    floor: String(delivery.floor || '').trim(),
    apartment: String(delivery.apartment || '').trim(),
    notes,
    items: normalizedItems,
    estimatedTotal,
    deliveryFee,
    grandTotal,
    unpricedItemCount,
    estimatedWeightItemCount,
  };
}

function getItemNote(item, payload) {
  const itemId = String(item && item.id || '').trim();
  const itemName = String(item && (item.name || item.productName) || '').trim();
  const itemNotes = payload && payload.itemNotes || {};
  const candidates = [
    item && item.note,
    item && item.notes,
    item && item.comment,
    item && item.comments,
    item && item.itemNote,
    item && item.productNote,
    item && item.product_notes,
    itemId && itemNotes[itemId],
    itemName && itemNotes[itemName],
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
    order.grandTotal,
    order.unpricedItemCount,
    order.email,
    initialCustomerEmailStatus,
    '',
    initialBusinessEmailStatus,
    '',
    initialTelegramStatus,
    '',
    order.editToken || '',
    '',
    '',
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
    line.note || '',
    '',
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

async function readOrderItemsByOrderId(sheets, spreadsheetId, orderId) {
  const itemsRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: ORDER_ITEMS_SHEET + '!A:' + columnLetter(ORDER_ITEM_HEADERS.length),
  }).catch(() => ({ data: { values: [] } }));
  const values = itemsRes.data.values || [];
  const items = [];

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][1] || '').trim() !== orderId) continue;
    items.push({
      name: String(values[i][2] || '').trim(),
      department: String(values[i][3] || '').trim(),
      mode: String(values[i][4] || '').trim() === 'משקל' ? 'kg' : 'unit',
      quantity: Number(values[i][5] || 0),
      orderUnit: String(values[i][6] || '').trim(),
      lineTotal: values[i][9] === '' || values[i][9] === undefined ? '' : Number(values[i][9]),
      note: String(values[i][10] || '').trim(),
      pickStatus: String(values[i][11] || '').trim(),
      rowNumber: i + 1,
    });
  }

  return items;
}

// Diff the previous order (item rows + the raw order row) against the freshly
// built order, so the business notifications can show exactly what changed.
function buildOrderChanges(previousItems, previousRow, order) {
  const prevByName = {};
  previousItems.forEach(p => { prevByName[normalizeProductName(p.name)] = p; });

  const newItems = (order.items || []).map(line => ({
    name: line.product.name,
    quantity: line.quantity,
    note: line.note || '',
  }));
  const newByName = {};
  newItems.forEach(n => { newByName[normalizeProductName(n.name)] = n; });

  const added = [];
  const changed = [];
  const removed = [];

  newItems.forEach(n => {
    const prev = prevByName[normalizeProductName(n.name)];
    if (!prev) {
      added.push(n);
    } else if (Number(prev.quantity) !== Number(n.quantity) || String(prev.note || '') !== String(n.note || '')) {
      changed.push({ name: n.name, fromQty: prev.quantity, toQty: n.quantity, fromNote: prev.note || '', toNote: n.note || '' });
    }
  });
  previousItems.forEach(p => {
    if (!newByName[normalizeProductName(p.name)]) removed.push(p);
  });

  const details = [];
  const addDetail = (label, before, after) => {
    if (String(before || '').trim() !== String(after || '').trim()) {
      details.push({ label, from: String(before || '').trim(), to: String(after || '').trim() });
    }
  };
  let prevPhone = String(previousRow[4] || '').trim();
  if (/^5\d{8}$/.test(prevPhone)) prevPhone = '0' + prevPhone;
  addDetail('שם', previousRow[3], order.fullName);
  addDetail('טלפון', prevPhone, order.phone);
  addDetail('מייל', previousRow[14], order.email);
  addDetail('שיטת הזמנה', previousRow[5], order.fulfillment);
  addDetail('כתובת/איסוף', previousRow[6], order.address);
  addDetail('קומה', previousRow[7], order.floor);
  addDetail('דירה', previousRow[8], order.apartment);
  addDetail('הערות', previousRow[9], order.notes);

  return { added, changed, removed, details };
}

// Read an existing order back for customer editing. Gated by the per-order
// edit token and by status === 'חדש' (orders-open is checked by the caller).
// Returns items by NAME (the client re-resolves them against the live catalog,
// because product ids are positional and shift week-to-week).
async function readOrderForEdit(orderId, editToken) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const rowNumber = await findOrderRowNumber(sheets, spreadsheetId, orderId);

  if (!rowNumber) return { ok: false, reason: 'notfound' };

  const endCol = columnLetter(ORDER_HEADERS.length);
  const rowRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: ORDERS_SHEET + '!A' + rowNumber + ':' + endCol + rowNumber,
  });
  const row = (rowRes.data.values && rowRes.data.values[0]) || [];
  const tokenCell = String(row[21] || '').trim();
  const statusCell = String(row[11] || '').trim();

  if (!tokenCell || tokenCell !== String(editToken || '').trim()) return { ok: false, reason: 'token' };
  if (statusCell !== ORDER_STATUS_NEW) return { ok: false, reason: 'locked' };

  const items = await readOrderItemsByOrderId(sheets, spreadsheetId, orderId);

  // Google Sheets stores the phone as a number, dropping the leading 0 on the
  // way in; restore it so the client's phone validation passes on re-submit.
  let phone = String(row[4] || '').trim();
  if (/^5\d{8}$/.test(phone)) phone = '0' + phone;

  // The stored address is "neighborhood, street" for delivery; split it back
  // so the client can re-select the neighborhood.
  const fulfillment = String(row[5] || '').trim();
  const composedAddress = String(row[6] || '').trim();
  let neighborhood = '';
  let address = composedAddress;

  if (fulfillment === 'משלוח' && composedAddress.indexOf(',') !== -1) {
    neighborhood = composedAddress.slice(0, composedAddress.indexOf(',')).trim();
    address = composedAddress.slice(composedAddress.indexOf(',') + 1).trim();
  }

  return {
    ok: true,
    order: {
      orderId,
      customer: { fullName: row[3] || '', phone: phone, email: row[14] || '' },
      fulfillment,
      delivery: { neighborhood, address, floor: row[7] || '', apartment: row[8] || '' },
      notes: row[9] || '',
      items,
    },
  };
}

// Replace an order's data in place (same orderId), so a customer edit never
// produces a duplicate order or a double-pick. Re-checks the gate (token +
// status) before writing. Item rows and the picking block are cleared and
// re-appended by the caller (appendPickingOrder re-adds the fresh block).
async function updateOrderInPlace(order, editToken) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const rowNumber = await findOrderRowNumber(sheets, spreadsheetId, order.orderId);

  if (!rowNumber) throw new Error('ההזמנה לא נמצאה. ייתכן שכבר נסגרה.');

  const endCol = columnLetter(ORDER_HEADERS.length);
  const rowRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: ORDERS_SHEET + '!A' + rowNumber + ':' + endCol + rowNumber,
  });
  const existing = (rowRes.data.values && rowRes.data.values[0]) || [];
  const existingToken = String(existing[21] || '').trim();
  const status = String(existing[11] || '').trim();

  if (!existingToken || existingToken !== String(editToken || '').trim()) {
    throw new Error('הקישור לעריכת ההזמנה אינו תקין.');
  }
  if (status !== ORDER_STATUS_NEW) {
    throw new Error('לא ניתן לעדכן את ההזמנה כי היא כבר בטיפול. אפשר ליצור קשר ונשמח לעזור.');
  }

  await Promise.all([
    ensureSheetHeaders(sheets, spreadsheetId, ORDERS_SHEET, ORDER_HEADERS),
    ensureSheetHeaders(sheets, spreadsheetId, ORDER_ITEMS_SHEET, ORDER_ITEM_HEADERS),
  ]);

  const createdAt = existing[0] || new Date().toISOString();
  const now = new Date().toISOString();
  order.editToken = existingToken;

  // Capture what changed (vs. the stored order) before we overwrite the rows.
  const previousItems = await readOrderItemsByOrderId(sheets, spreadsheetId, order.orderId);
  order.changes = buildOrderChanges(previousItems, existing, order);

  const initialCustomerEmailStatus = order.email ? VERCEL_IN_PROGRESS_STATUS : 'לא נמסר מייל';
  const initialBusinessEmailStatus = order.settings && order.settings.notificationEmails
    ? VERCEL_IN_PROGRESS_STATUS
    : 'לא הוגדר מייל';
  const initialTelegramStatus = order.settings && order.settings.telegramBotToken && order.settings.telegramChatId
    ? VERCEL_IN_PROGRESS_STATUS
    : 'לא הוגדר טלגרם';

  const orderRow = [
    createdAt,
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
    ORDER_STATUS_NEW,
    order.grandTotal,
    order.unpricedItemCount,
    order.email,
    initialCustomerEmailStatus,
    '',
    initialBusinessEmailStatus,
    '',
    initialTelegramStatus,
    '',
    existingToken,
    now,
    // Preserve any picking attribution already on the row (normally blank,
    // since updates are only allowed while status is still 'חדש').
    existing[22] || '',
    existing[23] || '',
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: ORDERS_SHEET + '!A' + rowNumber + ':' + endCol + rowNumber,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [orderRow] },
  });

  await deleteOrderItemRows(sheets, spreadsheetId, order.orderId);

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
    line.note || '',
    '',
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: ORDER_ITEMS_SHEET + '!A:' + columnLetter(ORDER_ITEM_HEADERS.length),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: itemRows },
  });

  // Delete the old picking block; the caller re-appends the fresh one via
  // appendPickingOrder (whose has-order guard now passes since it's gone).
  await deletePickingBlock(sheets, spreadsheetId, order.orderId);

  return { rowNumber, timestamp: now };
}

async function getSheetIdByTitle(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  });
  const found = (meta.data.sheets || []).find(s => s.properties && s.properties.title === title);
  return found ? found.properties.sheetId : null;
}

// Delete a contiguous range of rows (0-based, endIndex exclusive) from a tab,
// so updates don't leave blank gaps behind.
async function deleteSheetRows(sheets, spreadsheetId, sheetTitle, startIndex, endIndex) {
  if (endIndex <= startIndex) return;

  const sheetId = await getSheetIdByTitle(sheets, spreadsheetId, sheetTitle);
  if (sheetId === null || sheetId === undefined) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex, endIndex } } },
      ],
    },
  });
}

// Delete the contiguous item rows for an order (they are always appended as one
// block, so first..last covers only this order's lines).
async function deleteOrderItemRows(sheets, spreadsheetId, orderId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: ORDER_ITEMS_SHEET + '!B:B',
  }).catch(() => ({ data: { values: [] } }));
  const values = res.data.values || [];
  let first = -1;
  let last = -1;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === orderId) {
      if (first === -1) first = i;
      last = i;
    }
  }

  if (first === -1) return;

  // values index i === 0-based sheet row index; delete [first, last+1).
  await deleteSheetRows(sheets, spreadsheetId, ORDER_ITEMS_SHEET, first, last + 1);
}

// Delete an order's block in the picking sheet (from its 'מספר הזמנה' header row
// up to the next order's header row, including any trailing gap).
async function deletePickingBlock(sheets, spreadsheetId, orderId) {
  const values = await getPickingValues(sheets, spreadsheetId);
  let start = -1;

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === 'מספר הזמנה' && String(values[i][1] || '').trim() === orderId) {
      start = i;
      break;
    }
  }

  if (start === -1) return;

  let end = values.length;
  for (let j = start + 1; j < values.length; j++) {
    if (String(values[j][0] || '').trim() === 'מספר הזמנה') {
      end = j;
      break;
    }
  }

  await deleteSheetRows(sheets, spreadsheetId, PICKING_SHEET, start, end);
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
  const totalText = formatEstimatedTotal(order.estimatedTotal, order.unpricedItemCount, order.deliveryFee);
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
      formatLineQuantity(line),
      formatUnitLabel(line.orderUnit),
      formatMoney(line.product.price) + ' / ' + formatUnitLabel(line.product.priceUnit || ''),
      formatLineTotal(line),
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

function formatEstimatedTotal(total, unpricedItemCount, deliveryFee) {
  const fee = Number(deliveryFee || 0);
  let base = formatMoney((total || 0) + fee);

  if (Number(unpricedItemCount || 0) > 0) {
    base += ' + ' + unpricedItemCount + ' פריטים לפי חישוב בפועל';
  }

  if (fee > 0) {
    base += ' (כולל ₪' + formatMoney(fee) + ' משלוח)';
  }

  return base;
}

function formatLineQuantity(line) {
  const base = formatQuantity(line.quantity);

  if (line && line.isEstimatedWeightTotal && line.estimatedWeightKg) {
    return base + ' (כ-' + formatQuantity(line.estimatedWeightKg) + ' ק״ג משוער)';
  }

  return base;
}

function formatLineTotal(line) {
  if (typeof line.lineTotal !== 'number') {
    return 'לפי חישוב בפועל';
  }

  return formatMoney(line.lineTotal) + (line.isEstimatedPriceTotal ? ' משוער' : '');
}

function formatEstimatedWeightNote(line) {
  if (!line || !line.isEstimatedWeightTotal || !line.estimatedWeightPerUnitKg) {
    return '';
  }

  return 'חושב לפי משקל משוער של כ-' + formatQuantity(line.estimatedWeightPerUnitKg) + ' ק״ג ליחידה. החיוב הסופי לפי שקילה בפועל.';
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

function formatUnitLabel(value) {
  const text = String(value || '').trim();
  const compact = text.replace(/[״"]/g, '"').replace(/\s+/g, '');

  if (compact === 'קג' || compact === 'ק"ג') {
    return 'ק"ג';
  }

  return text;
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

// --- Team picking dashboard ---

// Map a raw order row (cols A:Y) to a compact summary for the team list.
// Never exposes the edit token (col V) to the dashboard.
function mapOrderSummary(row) {
  let phone = String(row[4] || '').trim();
  if (/^5\d{8}$/.test(phone)) phone = '0' + phone;

  return {
    orderId: String(row[1] || '').trim(),
    timestamp: String(row[0] || '').trim(),
    fullName: String(row[3] || '').trim(),
    phone,
    fulfillment: String(row[5] || '').trim(),
    address: String(row[6] || '').trim(),
    floor: String(row[7] || '').trim(),
    apartment: String(row[8] || '').trim(),
    notes: String(row[9] || '').trim(),
    itemCount: Number(row[10] || 0),
    status: String(row[11] || '').trim(),
    grandTotal: row[12] === '' || row[12] === undefined ? '' : Number(row[12]),
    unpricedItemCount: Number(row[13] || 0),
    email: String(row[14] || '').trim(),
    updatedAt: String(row[22] || '').trim(),
    collectedBy: String(row[23] || '').trim(),
    pickedAt: String(row[24] || '').trim(),
  };
}

// All orders for the team list, newest-first.
async function listOrdersForDashboard() {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: ORDERS_SHEET + '!A:Y',
  }).catch(() => ({ data: { values: [] } }));
  const values = res.data.values || [];

  const orders = [];
  for (let i = 1; i < values.length; i++) {
    const summary = mapOrderSummary(values[i]);
    if (summary.orderId) orders.push(summary);
  }

  orders.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return orders;
}

// Full order (customer details + items with picking state) for the detail view.
async function readOrderForDashboard(orderId) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const rowNumber = await findOrderRowNumber(sheets, spreadsheetId, orderId);

  if (!rowNumber) return { ok: false, reason: 'notfound' };

  const rowRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: ORDERS_SHEET + '!A' + rowNumber + ':Y' + rowNumber,
  });
  const summary = mapOrderSummary((rowRes.data.values && rowRes.data.values[0]) || []);
  const items = await readOrderItemsByOrderId(sheets, spreadsheetId, orderId);

  const addressText = buildAddressText({
    fulfillment: summary.fulfillment,
    address: summary.address,
    floor: summary.floor,
    apartment: summary.apartment,
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
      items: items.map(item => ({
        name: item.name,
        department: item.department,
        quantity: item.quantity,
        orderUnit: item.orderUnit,
        lineTotal: item.lineTotal,
        note: item.note,
        // Only items explicitly marked collected start checked; fresh ('') and
        // missing items start unchecked, so the picker checks each as collected.
        picked: item.pickStatus === ITEM_PICK_COLLECTED,
        pickStatus: item.pickStatus,
      })),
    },
  };
}

// Claim a waiting ('חדש') order for picking: set status to 'בליקוט' and record
// the team member. No-op once the order is past 'חדש' (already being handled).
async function claimOrderForPicking(orderId, member) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const rowNumber = await findOrderRowNumber(sheets, spreadsheetId, orderId);

  if (!rowNumber) return { ok: false, reason: 'notfound' };

  const statusRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: ORDERS_SHEET + '!L' + rowNumber,
  });
  const status = String(statusRes.data.values && statusRes.data.values[0] && statusRes.data.values[0][0] || '').trim();

  if (status !== ORDER_STATUS_NEW) return { ok: true, status, claimed: false };

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: ORDERS_SHEET + '!L' + rowNumber, values: [[ORDER_STATUS_PICKING]] },
        { range: ORDERS_SHEET + '!X' + rowNumber, values: [[String(member || '').trim()]] },
      ],
    },
  });

  return { ok: true, status: ORDER_STATUS_PICKING, claimed: true };
}

// Mark an order collected: write per-item picking state (col L of the items
// sheet) and resolve the order status server-side. With unpicked items, the
// behaviour depends on `closeMissing`:
//   - closeMissing !== false (default): unpicked → 'חסר', order → 'נאסף חלקית'
//     (closed, ready for shipment).
//   - closeMissing === false ("save & keep open"): collected items are saved as
//     'נאסף', unpicked items are left blank (stay pending) and the order stays
//     'בליקוט' so it can be finished later.
// When everything is picked the order is 'נאסף' regardless. Records who
// collected it and when.
async function updateOrderCollection(orderId, { member, items, closeMissing } = {}) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const rowNumber = await findOrderRowNumber(sheets, spreadsheetId, orderId);

  if (!rowNumber) return { ok: false, reason: 'notfound' };

  const pickedByName = {};
  (items || []).forEach(item => {
    pickedByName[normalizeProductName(item.name)] = item.picked !== false;
  });

  const existingItems = await readOrderItemsByOrderId(sheets, spreadsheetId, orderId);
  let anyMissing = false;
  existingItems.forEach(item => {
    const key = normalizeProductName(item.name);
    const picked = key in pickedByName ? pickedByName[key] : true;
    if (!picked) anyMissing = true;
  });

  // Keep the order open instead of closing it as partial.
  const keepOpen = anyMissing && closeMissing === false;

  const itemUpdates = existingItems.map(item => {
    const key = normalizeProductName(item.name);
    const picked = key in pickedByName ? pickedByName[key] : true;
    let cell;
    if (picked) cell = ITEM_PICK_COLLECTED;
    else cell = keepOpen ? '' : ITEM_PICK_MISSING;
    return {
      range: ORDER_ITEMS_SHEET + '!L' + item.rowNumber,
      values: [[cell]],
    };
  });

  let status;
  if (keepOpen) status = ORDER_STATUS_PICKING;
  else status = anyMissing ? ORDER_STATUS_PARTIAL : ORDER_STATUS_COLLECTED;
  const now = new Date().toISOString();

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: ORDERS_SHEET + '!L' + rowNumber, values: [[status]] },
        { range: ORDERS_SHEET + '!X' + rowNumber + ':Y' + rowNumber, values: [[String(member || '').trim(), now]] },
        ...itemUpdates,
      ],
    },
  });

  return { ok: true, status, pickedAt: now, collectedBy: String(member || '').trim() };
}

// Set an order's status directly (manual override from the dashboard). Writes
// col L. Reverting to 'חדש' also clears the picker attribution (X:Y) so the
// order looks fresh again; setting 'בליקוט' records the acting member.
async function setOrderStatus(orderId, status, member) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const rowNumber = await findOrderRowNumber(sheets, spreadsheetId, orderId);

  if (!rowNumber) return { ok: false, reason: 'notfound' };

  const data = [{ range: ORDERS_SHEET + '!L' + rowNumber, values: [[status]] }];
  let collectedBy;

  if (status === ORDER_STATUS_NEW) {
    data.push({ range: ORDERS_SHEET + '!X' + rowNumber + ':Y' + rowNumber, values: [['', '']] });
    collectedBy = '';
  } else if (status === ORDER_STATUS_PICKING && String(member || '').trim()) {
    collectedBy = String(member).trim();
    data.push({ range: ORDERS_SHEET + '!X' + rowNumber, values: [[collectedBy]] });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  return { ok: true, status, collectedBy };
}

// --- Catalog management (team dashboard) ---

// State <-> sheet status-cell text.
function statusToCell(state) {
  if (state === 'oos') return 'אזל';
  if (state === 'hidden') return 'לא';
  return ''; // active (empty cell reads as active)
}

function cellToState(statusCell) {
  if (isOutOfStock(statusCell)) return 'oos';
  if (!isActive(statusCell)) return 'hidden';
  return 'active';
}

// Read EVERY product row (including hidden / unpriced ones, which the customer
// catalog drops) so the team can manage them. Returns row numbers for editing.
async function readCatalogSheet() {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: PRODUCTS_SHEET,
  }).catch(() => ({ data: { values: [] } }));
  const rows = res.data.values || [];

  const products = [];
  if (rows.length > 1) {
    const columns = buildColumnMap(rows[0]);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = String(row[columns.name] || '').trim();
      if (!name) continue;
      const statusCell = columns.active === null ? '' : String(row[columns.active] || '');
      const columnWeight = columns.weight === null ? 0 : parsePrice(row[columns.weight]);
      const columnImage = columns.image === null ? '' : String(row[columns.image] || '').trim();
      products.push({
        rowNumber: i + 1,
        name,
        department: normalizeDepartment(row[columns.department]),
        unit: String(row[columns.unit] || '').trim(),
        priceUnit: columns.priceUnit === null ? '' : String(row[columns.priceUnit] || '').trim(),
        price: parsePrice(row[columns.price]),
        state: cellToState(statusCell),
        // Raw overrides (for the edit fields) + effective values (for preview).
        weightPerUnitKg: columnWeight > 0 ? columnWeight : '',
        autoWeightKg: getEstimatedUnitWeightKg(name) || '',
        image: columnImage,
        imageUrl: columnImage || getProductImageUrl(name),
      });
    }
  }

  return { products, departments: CATEGORY_ORDER.slice() };
}

// Make sure the price-unit and status columns exist, appending headers if not,
// so writes have somewhere to land. Returns the resolved column map + width.
async function ensureCatalogColumns(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: PRODUCTS_SHEET + '!1:1',
  }).catch(() => ({ data: { values: [] } }));
  let headers = (res.data.values && res.data.values[0] || []).slice();
  const columns = buildColumnMap(headers);
  let changed = false;

  // buildColumnMap defaults name/department/unit/price to 0..3 even without a
  // header; make sure the sheet is at least that wide.
  while (headers.length < 4) headers.push('');

  if (columns.priceUnit === null) {
    columns.priceUnit = headers.length;
    headers.push('יחידת מחיר');
    changed = true;
  }
  if (columns.active === null) {
    columns.active = headers.length;
    headers.push('סטטוס');
    changed = true;
  }
  if (columns.weight === null) {
    columns.weight = headers.length;
    headers.push('משקל ליחידה (ק"ג)');
    changed = true;
  }
  if (columns.image === null) {
    columns.image = headers.length;
    headers.push('תמונה');
    changed = true;
  }

  if (changed) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: PRODUCTS_SHEET + '!1:1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [headers] },
    });
  }

  return { columns, headerLength: headers.length };
}

async function addProduct(product) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const { columns, headerLength } = await ensureCatalogColumns(sheets, spreadsheetId);

  const row = new Array(headerLength).fill('');
  row[columns.name] = String(product.name || '').trim();
  row[columns.department] = normalizeDepartment(product.department);
  row[columns.unit] = String(product.unit || '').trim() || 'יחידות';
  row[columns.priceUnit] = String(product.priceUnit || '').trim() || row[columns.unit];
  row[columns.price] = product.price;
  row[columns.active] = statusToCell(product.state);
  row[columns.weight] = (product.weightPerUnitKg === '' || product.weightPerUnitKg == null) ? '' : product.weightPerUnitKg;
  row[columns.image] = String(product.imageUrl || '').trim();

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: PRODUCTS_SHEET + '!A:' + columnLetter(headerLength),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  return { ok: true };
}

async function updateProduct(rowNumber, product) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const { columns } = await ensureCatalogColumns(sheets, spreadsheetId);

  const data = [];
  const setCell = (idx, value) => {
    if (idx === null || idx === undefined) return;
    data.push({ range: PRODUCTS_SHEET + '!' + columnLetter(idx + 1) + rowNumber, values: [[value]] });
  };

  if (product.name !== undefined) setCell(columns.name, String(product.name).trim());
  if (product.department !== undefined) setCell(columns.department, normalizeDepartment(product.department));
  if (product.unit !== undefined) setCell(columns.unit, String(product.unit).trim());
  if (product.priceUnit !== undefined) setCell(columns.priceUnit, String(product.priceUnit).trim());
  if (product.price !== undefined) setCell(columns.price, product.price);
  if (product.state !== undefined) setCell(columns.active, statusToCell(product.state));
  if (product.weightPerUnitKg !== undefined) {
    setCell(columns.weight, (product.weightPerUnitKg === '' || product.weightPerUnitKg == null) ? '' : product.weightPerUnitKg);
  }
  if (product.imageUrl !== undefined) setCell(columns.image, String(product.imageUrl || '').trim());

  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
  }

  return { ok: true };
}

async function deleteProduct(rowNumber) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  await deleteSheetRows(sheets, spreadsheetId, PRODUCTS_SHEET, rowNumber - 1, rowNumber);
  return { ok: true };
}

module.exports = {
  // Low-level Sheets access (used by the one-time Sheets→Postgres backfill).
  getSheetsClient,
  // Pure, storage-agnostic helpers reused by the Postgres store (lib/store.js).
  defaultSettings,
  groupProducts,
  getUnitType,
  applyUnitDeal,
  getEstimatedUnitWeightKg,
  getProductImageUrl,
  formatPrice,
  parsePrice,
  normalizeDepartment,
  normalizeProductName,
  formatEstimatedTotal,
  buildAddressText,
  normalizeCustomerPhone,
  FREE_DELIVERY_THRESHOLD,
  DELIVERY_FEE,
  CATEGORY_ORDER,
  VERCEL_IN_PROGRESS_STATUS,
  readCatalog,
  parseSettings,
  parseProducts,
  validateAndBuildOrder,
  buildOrderChanges,
  writeOrder,
  readOrderForEdit,
  updateOrderInPlace,
  appendPickingOrder,
  updateOrderNotificationStatuses,
  getSpreadsheetId,
  listOrdersForDashboard,
  readOrderForDashboard,
  claimOrderForPicking,
  updateOrderCollection,
  setOrderStatus,
  ORDER_STATUS_NEW,
  ORDER_STATUS_PICKING,
  ORDER_STATUS_COLLECTED,
  ORDER_STATUS_PARTIAL,
  ORDER_STATUS_SENT,
  ORDER_STATUS_HANDED,
  readCatalogSheet,
  addProduct,
  updateProduct,
  deleteProduct,
};
