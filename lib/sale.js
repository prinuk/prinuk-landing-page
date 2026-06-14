/**
 * Sale management: publish next week's prices from the חישוב מחירים spreadsheet
 * into the Postgres catalog, and open/close the sale.
 *
 * Improvements over the old Apps Script "refresh + archive" flow:
 * - Smart-merge (match by product name) instead of full-replace, so images,
 *   weights, and other catalog data set in the dashboard are PRESERVED.
 * - Explicit open/closed switch (settings.saleStatus) instead of "all prices
 *   empty"; closing never wipes prices.
 *
 * The price computation stays in the חישוב מחירים spreadsheet (a tab named after
 * the sale, matching settings.saleName). This module only reads it (HTTPS) and
 * writes the result to Postgres.
 */
const { eq } = require('drizzle-orm');
const { db, schema } = require('./db/client');
const {
  getSheetsClient,
  parsePrice,
  normalizeDepartment,
  normalizeProductName,
} = require('./sheets');

const { products: productsT, settings: settingsT } = schema;

function normHeader(v) {
  return String(v || '').trim().replace(/[״"]/g, '"').replace(/[׳']/g, "'").replace(/\s+/g, ' ').toLowerCase();
}

// Map the pricing tab's header row to the fields we need (flexible names).
function buildPricingColumnMap(headers) {
  const map = { name: null, department: null, unit: null, priceUnit: null, price: null, weight: null, image: null };
  (headers || []).forEach((header, index) => {
    const v = normHeader(header);
    if (!v) return;
    if (v === 'שם' || v === 'שם מוצר' || v === 'מוצר' || v === 'name' || v === 'product') map.name = index;
    else if (v.includes('תמונה') || v.includes('image')) map.image = index;
    else if (v.includes('משקל') || v.includes('weight')) map.weight = index;
    else if (v.includes('מחלקה') || v.includes('קטגוריה') || v === 'department' || v === 'category') map.department = index;
    else if (v.includes('יחידת') && v.includes('מחיר')) map.priceUnit = index;
    else if (v.includes('מחיר') && (v.includes('צרכן') || v.includes('לצרכן'))) map.price = index;
    else if (v.includes('יחידת') || v === 'יחידה' || v === 'unit') map.unit = index;
    else if (v.includes('מחיר') || v === 'price') { if (map.price === null) map.price = index; }
  });
  return map;
}

async function readSettingsMap() {
  const rows = await db.select().from(settingsT);
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });
  return map;
}

async function upsertSetting(tx, key, value) {
  await tx
    .insert(settingsT)
    .values({ key, value: String(value) })
    .onConflictDoUpdate({ target: settingsT.key, set: { value: String(value), updatedAt: new Date() } });
}

// Read the pricing spreadsheet tab named `saleName` and return parsed rows.
async function readPricingRows(pricingSpreadsheetId, saleName) {
  const sheets = await getSheetsClient();
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: pricingSpreadsheetId,
      range: "'" + saleName + "'",
    });
  } catch (e) {
    throw new Error('לא נמצא גיליון בשם "' + saleName + '" בקובץ חישוב מחירים.');
  }
  const rows = res.data.values || [];
  if (rows.length < 2) throw new Error('הגיליון "' + saleName + '" בקובץ חישוב מחירים ריק.');

  const cols = buildPricingColumnMap(rows[0]);
  if (cols.name === null || cols.price === null) {
    throw new Error('בקובץ חישוב מחירים חסרות עמודות חובה: שם ו/או מחיר לצרכן.');
  }

  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = String(r[cols.name] || '').trim();
    if (!name) continue;
    const price = parsePrice(r[cols.price]);
    if (!price || price <= 0) continue; // unpriced rows are not part of the sale
    items.push({
      name,
      department: cols.department === null ? 'אחר' : normalizeDepartment(r[cols.department]),
      unit: cols.unit === null ? 'יחידות' : String(r[cols.unit] || '').trim() || 'יחידות',
      priceUnit: cols.priceUnit === null ? '' : String(r[cols.priceUnit] || '').trim(),
      price,
      weight: cols.weight === null ? null : parsePrice(r[cols.weight]),
      image: cols.image === null ? '' : String(r[cols.image] || '').trim(),
    });
  }
  return items;
}

// Publish a sale: import prices from חישוב מחירים, smart-merge into Postgres,
// and open the sale. Preserves existing images/weights unless the pricing tab
// provides them. Products not in this week's tab are hidden (data kept).
async function publishSale({ saleName, pricingSpreadsheetId } = {}) {
  const cfg = await readSettingsMap();
  const name = String(saleName || cfg.saleName || '').trim();
  if (!name) throw new Error('חסר שם מכירה (שם הגיליון בקובץ חישוב מחירים).');

  const pricingId = String(pricingSpreadsheetId || process.env.PRICING_SPREADSHEET_ID || '').trim();
  if (!pricingId) throw new Error('חסר מזהה קובץ חישוב מחירים. הגדירו PRICING_SPREADSHEET_ID.');

  const incoming = await readPricingRows(pricingId, name);
  if (!incoming.length) throw new Error('לא נמצאו מוצרים עם מחיר בגיליון "' + name + '".');

  const existing = await db.select().from(productsT);
  const byName = new Map(existing.map((p) => [normalizeProductName(p.name), p]));
  const incomingNames = new Set(incoming.map((x) => normalizeProductName(x.name)));

  let updated = 0;
  let added = 0;
  let hidden = 0;

  await db.transaction(async (tx) => {
    for (const item of incoming) {
      const ex = byName.get(normalizeProductName(item.name));
      const priceAgorot = Math.round(item.price * 100);
      if (ex) {
        const set = {
          priceAgorot,
          department: item.department,
          unit: item.unit,
          state: 'active',
          updatedAt: new Date(),
        };
        if (item.priceUnit) set.priceUnit = item.priceUnit;
        if (item.image) set.imageUrl = item.image; // else keep existing
        if (item.weight != null && item.weight > 0) set.weightPerUnitKg = String(item.weight);
        await tx.update(productsT).set(set).where(eq(productsT.id, ex.id));
        updated += 1;
      } else {
        await tx.insert(productsT).values({
          name: item.name,
          department: item.department,
          unit: item.unit,
          priceUnit: item.priceUnit || item.unit,
          priceAgorot,
          state: 'active',
          weightPerUnitKg: item.weight != null && item.weight > 0 ? String(item.weight) : null,
          imageUrl: item.image || '',
        });
        added += 1;
      }
    }

    // Products not in this week's sale → hidden (keep their data for next time).
    for (const p of existing) {
      if (!incomingNames.has(normalizeProductName(p.name)) && p.state !== 'hidden') {
        await tx.update(productsT).set({ state: 'hidden', updatedAt: new Date() }).where(eq(productsT.id, p.id));
        hidden += 1;
      }
    }

    await upsertSetting(tx, 'saleName', name);
    await upsertSetting(tx, 'saleStatus', 'open');
  });

  return { ok: true, saleName: name, total: incoming.length, updated, added, hidden };
}

// Open/close the sale without touching prices.
async function setSaleStatus(status) {
  const value = status === 'closed' ? 'closed' : 'open';
  await db.transaction(async (tx) => {
    await upsertSetting(tx, 'saleStatus', value);
  });
  return { ok: true, saleStatus: value };
}

async function getSaleStatus() {
  const cfg = await readSettingsMap();
  return { saleStatus: cfg.saleStatus === 'closed' ? 'closed' : 'open', saleName: cfg.saleName || '' };
}

module.exports = { publishSale, setSaleStatus, getSaleStatus };
