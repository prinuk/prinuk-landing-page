const crypto = require('crypto');
const {
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
  reviewAndCharge,
  reviewAndIssueDocument,
  issueChargedInvoice,
  setOrderPaymentMethod,
  setOrderPaymentStatusManual,
  createManualOrder,
  adminUpdateOrder,
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
  bulkUpdateProductStatus,
  getSettings,
  updateSettings,
} = require('../lib/store');
const { publishSale, setSaleStatus, getSaleStatus } = require('../lib/sale');
const { createOrdersFullPdf, createOrdersHeadersPdf } = require('../lib/orders-pdf');
const { createWeightSummaryPdf } = require('../lib/weight-summary-pdf');
const { sendPickedOrderTelegram } = require('../lib/telegram');
const { paymentsEnabled, getPaymentAdapter } = require('../lib/payments');
const { sendCustomerFinalEmail } = require('../lib/email');

const ALLOWED_STATUSES = [
  ORDER_STATUS_NEW,
  ORDER_STATUS_PICKING,
  ORDER_STATUS_COLLECTED,
  ORDER_STATUS_PARTIAL,
  ORDER_STATUS_SENT,
  ORDER_STATUS_HANDED,
  'מבוטל', // cancelled (soft delete via set-status)
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

  // Optional "X for Y" quantity deal: both parts required together (or both blank).
  let dealQty = '';
  let dealPrice = '';
  const hasQty = p.dealQty !== '' && p.dealQty != null;
  const hasPrice = p.dealPrice !== '' && p.dealPrice != null;
  if (hasQty || hasPrice) {
    if (!hasQty || !hasPrice) return { error: 'יש למלא גם כמות וגם מחיר מבצע.' };
    dealQty = Math.floor(Number(p.dealQty));
    dealPrice = Number(p.dealPrice);
    if (!isFinite(dealQty) || dealQty < 2) return { error: 'כמות מבצע חייבת להיות 2 ומעלה.' };
    if (!isFinite(dealPrice) || dealPrice < 0) return { error: 'מחיר מבצע לא תקין.' };
  }

  return {
    product: {
      name,
      department: String(p.department || '').trim() || 'אחר',
      unit: String(p.unit || '').trim() || 'יחידות',
      priceUnit: String(p.priceUnit || '').trim(),
      price: price,
      dealQty: dealQty,
      dealPrice: dealPrice,
      orderCutoff: !!p.orderCutoff,
      subcategory: String(p.subcategory || '').trim(),
      volumeMl: p.volumeMl === '' || p.volumeMl == null ? '' : Number(p.volumeMl),
      vatExempt: p.vatExempt !== false,
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

// Parse the order-list scope from query params: ?all=1 | ?from=&to= | ?saleName=
// Default (no params) → current sale (resolved in the store).
function parseOrderScope(query) {
  const q = query || {};
  if (q.all === '1' || q.all === 'true') return { all: true };
  if (q.from || q.to) return { from: q.from || '', to: q.to || '' };
  if (q.saleName != null && q.saleName !== '') return { saleName: String(q.saleName) };
  return {};
}

// Send the customer's final email (collected summary + invoice if present).
// Returns { sent, reason?, status?, hasInvoice }.
async function sendFinalEmailFor(orderId) {
  const detail = await readOrderForDashboard(orderId);
  const o = detail && detail.ok ? detail.order : null;
  if (!o) return { sent: false, reason: 'notfound' };
  if (!o.email) return { sent: false, reason: 'no-email' };
  const settings = await getSettings();
  const invoiceUrl = (o.payment && o.payment.invoiceUrl) || '';
  const amount = (o.finalTotal !== '' && o.finalTotal != null)
    ? o.finalTotal
    : (o.actualTotal != null ? o.actualTotal : null);
  const fe = await sendCustomerFinalEmail(settings, o, o.items, { invoiceUrl, amount });
  return { sent: true, status: fe && fe.status, hasInvoice: !!invoiceUrl };
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

      if (action === 'sales') {
        const sales = await getSalesList();
        return res.json({ ok: true, sales });
      }

      if (action === 'weekly-report') {
        const weeks = await getWeeklyReport();
        return res.json({ ok: true, weeks });
      }

      if (action === 'orders-timeline') {
        const sales = await getOrdersTimeline();
        return res.json({ ok: true, sales });
      }

      if (action === 'customers') {
        const customers = await getCustomers({
          mode: String((req.query && req.query.mode) || 'all').trim(),
          saleName: String((req.query && req.query.saleName) || '').trim(),
        });
        return res.json({ ok: true, customers });
      }

      if (action === 'weight-summary') {
        const summary = await getWeightSummary(parseOrderScope(req.query));
        return res.json({ ok: true, ...summary });
      }

      if (action === 'settings') {
        const settings = await getSettings();
        const payments = paymentsEnabled()
          ? Object.assign({ enabled: true }, getPaymentAdapter().publicConfig())
          : { enabled: false };
        return res.json({ ok: true, settings, payments });
      }

      const orders = await listOrdersForDashboard(parseOrderScope(req.query));
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

      if (action === 'products-bulk-status') {
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const status = String(body.status || '');
        if (!ids.length) return res.status(400).json({ error: 'לא נבחרו מוצרים.' });
        const result = await bulkUpdateProductStatus(ids, status);
        if (!result.ok) return res.status(400).json({ error: 'סטטוס לא תקין.' });
        return res.json(result);
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

      // --- Order printing (returns a PDF; authenticated, contains PII) ---
      if (action === 'orders-pdf') {
        const mode = ['headers', 'picked'].includes(body.mode) ? body.mode : 'full';
        const opts = Array.isArray(body.codes) && body.codes.length
          ? { codes: body.codes.map(String) }
          : { scope: body.scope || {} };
        const orders = await getOrdersDetailed(opts);
        if (!orders.length) return res.status(400).json({ error: 'אין הזמנות להדפסה.' });
        const settings = await getSettings();
        let pdf;
        if (mode === 'headers') {
          pdf = await createOrdersHeadersPdf(orders, settings);
        } else if (mode === 'picked') {
          // Same document produced when an order is collected (final weighed
          // amounts, no estimate), but for the whole selected set together.
          pdf = await createOrdersFullPdf(orders, settings, {
            title: settings.saleName ? 'הזמנות שנאספו — ' + settings.saleName : 'הזמנות שנאספו',
            hideEstimate: true,
          });
        } else {
          // Printed orders show the final (collected) amount only — no estimate,
          // no sale-name title header.
          pdf = await createOrdersFullPdf(orders, settings, { hideEstimate: true, hideTitle: true });
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="orders.pdf"');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(Buffer.from(pdf));
      }

      if (action === 'weight-summary-pdf') {
        const summary = await getWeightSummary(body.scope || {});
        if (!summary.items.length) return res.status(400).json({ error: 'אין נתונים להדפסה.' });
        const settings = await getSettings();
        const pdf = await createWeightSummaryPdf(summary, settings);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="weight-summary.pdf"');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(Buffer.from(pdf));
      }

      // Team-created invoice (POS): new order from a product list, optional charge.
      if (action === 'create-order') {
        const result = await createManualOrder(Object.assign({}, body.order || {}, { member: String(body.member || '').trim() }));
        if (!result.ok) {
          return res.status(400).json({ error: result.reason === 'no-items' ? 'יש להוסיף מוצרים.' : (result.error || 'יצירת ההזמנה נכשלה.') });
        }
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

        // When the pick is finalized (not kept open for missing items), send a
        // summary + the order PDF to the dedicated Telegram channel. Best-effort:
        // a notification failure must never fail the collect itself. The reason
        // is always surfaced on result.telegram so the dashboard can show it.
        if (result.status === 'בליקוט') {
          result.telegram = { sent: false, reason: 'pick-kept-open' };
        } else {
          try {
            const detailed = await getOrdersDetailed({ codes: [orderId] });
            const order = detailed[0];
            const settings = await getSettings();
            if (!order) {
              result.telegram = { sent: false, reason: 'order-not-found' };
            } else if (!settings.telegramBotToken) {
              result.telegram = { sent: false, reason: 'no-bot-token' };
            } else if (!settings.telegramPickedChatId) {
              result.telegram = { sent: false, reason: 'no-picked-chat-id' };
            } else {
              const pdf = await createOrdersFullPdf([order], settings, {
                title: settings.saleName ? 'הזמנה שנאספה — ' + settings.saleName : 'הזמנה שנאספה',
                hideEstimate: true,
              });
              result.telegram = await sendPickedOrderTelegram(settings, order, Buffer.from(pdf));
            }
          } catch (err) {
            console.error('Picked-order Telegram failed:', err);
            result.telegram = { sent: false, reason: err.message || 'failed' };
          }
        }
        return res.json(result);
      }

      if (action === 'charge') {
        // With a review payload (adjusted items + discounts) → apply then charge;
        // otherwise charge the order as-is.
        const result = body.review
          ? await reviewAndCharge(orderId, body.review)
          : await chargeOrder(orderId);
        if (!result.ok) {
          const msgs = {
            notfound: 'ההזמנה לא נמצאה.',
            'not-credit': 'זו אינה הזמנת אשראי.',
            'no-card': 'לא נשמר כרטיס אשראי להזמנה זו.',
            'no-amount': 'אין סכום לחיוב.',
            'no-items': 'אין פריטים לחיוב.',
            'charge-failed': result.error || 'החיוב נכשל.',
          };
          return res.status(400).json({ error: msgs[result.reason] || result.error || 'החיוב נכשל.' });
        }
        // Only auto-email the customer when an invoice was actually created. If the
        // charge succeeded but the invoice failed, DON'T email — flag it so the team
        // can retry the invoice or explicitly send without one.
        if (!result.alreadyCharged) {
          if (result.invoiceUrl) {
            try { const fe = await sendFinalEmailFor(orderId); result.finalEmail = fe.status; }
            catch (err) { console.error('Final email failed:', err); }
          } else {
            result.invoiceMissing = true;
          }
        }
        return res.json(result);
      }

      // Explicitly send the customer's final email (used for "send without invoice"
      // after a charge whose invoice failed) — requires the team's action.
      if (action === 'send-final-email') {
        const fe = await sendFinalEmailFor(orderId);
        if (!fe.sent) return res.status(400).json({ error: fe.reason === 'no-email' ? 'אין כתובת מייל ללקוח.' : 'ההזמנה לא נמצאה.' });
        return res.json({ ok: true, finalEmail: fe.status, hasInvoice: fe.hasInvoice });
      }

      // Issue a חשבונית מס for an order paid OUTSIDE Cardcom (transfer/Bit/cash).
      if (action === 'issue-document') {
        const result = await reviewAndIssueDocument(orderId, body.review || {});
        if (!result.ok) {
          const msgs = {
            notfound: 'ההזמנה לא נמצאה.',
            unsupported: 'הפקת חשבונית אינה נתמכת בספק התשלומים הנוכחי.',
            'no-amount': 'אין סכום להפקת חשבונית.',
            'no-items': 'אין פריטים להפקת חשבונית.',
            'document-failed': result.error || 'הפקת החשבונית נכשלה.',
          };
          return res.status(400).json({ error: msgs[result.reason] || result.error || 'הפקת החשבונית נכשלה.' });
        }
        // Final email to the customer: collected summary + the tax invoice (best-effort).
        try {
          const detail = await readOrderForDashboard(orderId);
          const o = detail && detail.ok ? detail.order : null;
          if (o && o.email) {
            const settings = await getSettings();
            const fe = await sendCustomerFinalEmail(settings, o, o.items, {
              invoiceUrl: result.invoiceUrl || (o.payment && o.payment.invoiceUrl) || '',
              amount: result.amount,
            });
            result.finalEmail = fe && fe.status;
          }
        } catch (err) {
          console.error('Final email (external document) failed:', err);
        }
        return res.json(result);
      }

      if (action === 'set-payment-method') {
        const result = await setOrderPaymentMethod(orderId, String(body.method || ''));
        if (!result.ok) {
          const msgs = { notfound: 'ההזמנה לא נמצאה.', locked: 'לא ניתן לשנות אמצעי תשלום לאחר חיוב.' };
          return res.status(400).json({ error: msgs[result.reason] || 'שגיאה בשינוי אמצעי התשלום.' });
        }
        return res.json(result);
      }

      // Issue the missing invoice for an already-charged card order (deal-linked).
      if (action === 'issue-charged-invoice') {
        const result = await issueChargedInvoice(orderId);
        if (!result.ok) {
          const msgs = {
            notfound: 'ההזמנה לא נמצאה.',
            unsupported: 'לא נתמך בספק התשלומים הנוכחי.',
            'not-charged': 'ההזמנה לא חויבה באשראי.',
            'already-invoiced': 'כבר קיימת חשבונית להזמנה זו.',
            'no-deal': 'אין מזהה עסקה לשיוך החשבונית.',
            'document-failed': result.error || 'הפקת החשבונית נכשלה.',
          };
          return res.status(400).json({ error: msgs[result.reason] || result.error || 'הפקת החשבונית נכשלה.' });
        }
        // Invoice now exists → send the customer's final email with it.
        try { const fe = await sendFinalEmailFor(orderId); result.finalEmail = fe.status; }
        catch (err) { console.error('Final email (after re-issue) failed:', err); }
        return res.json(result);
      }

      if (action === 'set-payment-status') {
        const result = await setOrderPaymentStatusManual(orderId, String(body.status || ''));
        if (!result.ok) return res.status(400).json({ error: result.reason === 'notfound' ? 'ההזמנה לא נמצאה.' : 'שגיאה בעדכון סטטוס התשלום.' });
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

      if (action === 'order-update') {
        try {
          const result = await adminUpdateOrder(orderId, body.payload || {});
          return res.json(result);
        } catch (err) {
          return res.status(400).json({ error: err.message || 'שגיאה בעדכון ההזמנה.' });
        }
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
