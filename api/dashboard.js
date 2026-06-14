const crypto = require('crypto');
const {
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
  getSettings,
  updateSettings,
} = require('../lib/store');
const { publishSale, setSaleStatus, getSaleStatus } = require('../lib/sale');

const ALLOWED_STATUSES = [
  ORDER_STATUS_NEW,
  ORDER_STATUS_PICKING,
  ORDER_STATUS_COLLECTED,
  ORDER_STATUS_PARTIAL,
  ORDER_STATUS_SENT,
  ORDER_STATUS_HANDED,
];

// Validate + normalize a product payload from the client.
function cleanProduct(raw) {
  const p = raw || {};
  const name = String(p.name || '').trim();
  const price = Number(p.price);
  const states = ['active', 'oos', 'hidden'];
  const state = states.indexOf(p.state) !== -1 ? p.state : 'active';
  if (!name) return { error: 'חסר שם מוצר.' };
  if (!isFinite(price) || price < 0) return { error: 'מחיר לא תקין.' };

  let weightPerUnitKg = '';
  if (p.weightPerUnitKg !== '' && p.weightPerUnitKg != null) {
    weightPerUnitKg = Number(p.weightPerUnitKg);
    if (!isFinite(weightPerUnitKg) || weightPerUnitKg < 0) return { error: 'משקל לא תקין.' };
  }

  return {
    product: {
      name,
      department: String(p.department || '').trim() || 'אחר',
      unit: String(p.unit || '').trim() || 'יחידות',
      priceUnit: String(p.priceUnit || '').trim(),
      price: price,
      state: state,
      weightPerUnitKg: weightPerUnitKg,
      imageUrl: String(p.imageUrl || '').trim(),
    },
  };
}

// Find the Vercel Blob read/write token. Prefer the standard name, but fall
// back to any env var whose VALUE looks like a Blob RW token, since Vercel may
// name it per-store (e.g. <STORE>_READ_WRITE_TOKEN).
function getBlobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const keys = Object.keys(process.env);
  for (let i = 0; i < keys.length; i++) {
    const value = process.env[keys[i]];
    if (typeof value === 'string' && value.indexOf('vercel_blob_rw_') === 0) return value;
  }
  return '';
}

// Upload a (client-downscaled) image data URL to Vercel Blob, return its URL.
async function uploadImage(dataUrl, name) {
  const match = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new Error('קובץ תמונה לא תקין.');

  const token = getBlobToken();
  if (!token) {
    throw new Error('אחסון התמונות לא מוגדר. ודאו ש-Blob store מחובר לפרויקט ושיש משתנה BLOB_READ_WRITE_TOKEN, ואז פרסו מחדש.');
  }

  const contentType = match[1];
  const ext = contentType === 'image/png' ? 'png' : (contentType === 'image/webp' ? 'webp' : 'jpg');
  const buffer = Buffer.from(match[3], 'base64');
  if (buffer.length > 4 * 1024 * 1024) throw new Error('התמונה גדולה מדי.');

  const slug = String(name || 'product')
    .trim().replace(/[^0-9A-Za-z֐-׿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'product';

  const { put } = require('@vercel/blob');
  const result = await put('products/' + slug + '-' + Date.now() + '.' + ext, buffer, {
    access: 'public',
    contentType: contentType,
    token: token,
  });

  return result.url;
}

// Constant-time compare of the supplied key against DASHBOARD_PASSWORD.
function isAuthorized(req) {
  const expected = String(process.env.DASHBOARD_PASSWORD || '');
  if (!expected) return false; // fail closed if no password is configured

  const provided = String(
    (req.headers && (req.headers['x-dashboard-key'] || req.headers['X-Dashboard-Key'])) || '',
  );
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'הסיסמה שגויה.' });
  }

  try {
    if (req.method === 'GET') {
      const action = String((req.query && req.query.action) || 'list').trim();

      if (action === 'order') {
        const orderId = String((req.query && req.query.id) || '').trim();
        if (!orderId) return res.status(400).json({ error: 'חסר מספר הזמנה.' });
        const result = await readOrderForDashboard(orderId);
        if (!result.ok) return res.status(404).json({ error: 'ההזמנה לא נמצאה.' });
        return res.json({ ok: true, order: result.order });
      }

      if (action === 'products') {
        const data = await readCatalogSheet();
        return res.json({ ok: true, products: data.products, departments: data.departments });
      }

      if (action === 'sale-status') {
        const data = await getSaleStatus();
        return res.json({ ok: true, ...data });
      }

      if (action === 'settings') {
        const settings = await getSettings();
        return res.json({ ok: true, settings });
      }

      const orders = await listOrdersForDashboard();
      return res.json({ ok: true, orders });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const action = String(body.action || '').trim();

      // --- Catalog management ---
      if (action === 'image-upload') {
        try {
          const url = await uploadImage(body.dataUrl, body.name);
          return res.json({ ok: true, url: url });
        } catch (err) {
          console.error('Image upload failed:', err);
          return res.status(400).json({ error: err.message || 'שגיאה בהעלאת התמונה.' });
        }
      }

      if (action === 'product-add') {
        const cleaned = cleanProduct(body.product);
        if (cleaned.error) return res.status(400).json({ error: cleaned.error });
        await addProduct(cleaned.product);
        return res.json({ ok: true });
      }

      if (action === 'product-update') {
        const id = String(body.id || '').trim();
        if (!id) return res.status(400).json({ error: 'מזהה מוצר חסר.' });
        const cleaned = cleanProduct(body.product);
        if (cleaned.error) return res.status(400).json({ error: cleaned.error });
        await updateProduct(id, cleaned.product);
        return res.json({ ok: true });
      }

      if (action === 'product-delete') {
        const id = String(body.id || '').trim();
        if (!id) return res.status(400).json({ error: 'מזהה מוצר חסר.' });
        await deleteProduct(id);
        return res.json({ ok: true });
      }

      // --- Sale management ---
      if (action === 'publish-sale') {
        const result = await publishSale({
          saleName: String(body.saleName || '').trim(),
          dryRun: body.dryRun === true,
        });
        return res.json(result);
      }

      if (action === 'set-sale-status') {
        const result = await setSaleStatus(String(body.status || '').trim());
        return res.json(result);
      }

      if (action === 'settings-update') {
        const result = await updateSettings(body.settings || {});
        return res.json(result);
      }

      // --- Order actions ---
      const orderId = String(body.orderId || '').trim();
      const member = String(body.member || '').trim();

      if (!orderId) return res.status(400).json({ error: 'חסר מספר הזמנה.' });

      if (action === 'claim') {
        const result = await claimOrderForPicking(orderId, member);
        if (!result.ok) return res.status(404).json({ error: 'ההזמנה לא נמצאה.' });
        return res.json(result);
      }

      if (action === 'collect') {
        const items = Array.isArray(body.items) ? body.items : [];
        const result = await updateOrderCollection(orderId, { member, items, closeMissing: body.closeMissing !== false });
        if (!result.ok) return res.status(404).json({ error: 'ההזמנה לא נמצאה.' });
        return res.json(result);
      }

      if (action === 'set-status') {
        const status = String(body.status || '').trim();
        if (ALLOWED_STATUSES.indexOf(status) === -1) {
          return res.status(400).json({ error: 'סטטוס לא תקין.' });
        }
        const result = await setOrderStatus(orderId, status, member);
        if (!result.ok) return res.status(404).json({ error: 'ההזמנה לא נמצאה.' });
        return res.json(result);
      }

      return res.status(400).json({ error: 'פעולה לא תקינה.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Dashboard error:', error);
    // Internal tool — surface the actual (Hebrew) reason to help the team
    // diagnose (e.g. missing PRICING_SPREADSHEET_ID), not just a generic message.
    return res.status(500).json({ error: error.message || 'שגיאה בטעינת הנתונים. נסו שוב בעוד רגע.' });
  }
};
