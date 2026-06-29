const {
  appendPickingOrder,
  readCatalog,
  readOrderForEdit,
  updateOrderInPlace,
  updateOrderNotificationStatuses,
  validateAndBuildOrder,
  writeOrder,
} = require('../lib/store');
const { paymentsEnabled, getPaymentAdapter } = require('../lib/payments');
const { sendBusinessOrderEmail, sendCustomerOrderEmail } = require('../lib/email');
const { createOrderPdf, createOrderChangesPdf } = require('../lib/order-pdf');
const { sendTelegramOrder } = require('../lib/telegram');

const EDIT_REASON_MESSAGES = {
  notfound: 'לא מצאנו את ההזמנה. ייתכן שכבר נסגרה.',
  token: 'הקישור לעריכת ההזמנה אינו תקין.',
  locked: 'ההזמנה כבר בטיפול ולא ניתן לעדכן אותה. אפשר ליצור קשר ונשמח לעזור.',
  closed: 'ההזמנות סגורות כרגע, לכן לא ניתן לעדכן את ההזמנה.',
};

// Time-limited items ("ניתן להזמין עד …") — server-side mirror of the client
// guard in order/index.html, so a page loaded before the cutoff can't POST a
// closed item after it.
function parseHHMM(value, fallbackMinutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return fallbackMinutes;
  const h = +m[1];
  const mn = +m[2];
  if (h > 23 || mn > 59) return fallbackMinutes;
  return h * 60 + mn;
}
function israelNowMinutes() {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    let h = 0;
    let mn = 0;
    parts.forEach((p) => { if (p.type === 'hour') h = +p.value; if (p.type === 'minute') mn = +p.value; });
    return h * 60 + mn;
  } catch (e) {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }
}
function israelWeekday() {
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(new Date());
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[s] != null ? map[s] : new Date().getDay();
  } catch (e) {
    return new Date().getDay();
  }
}
// Time-limited items are orderable until orderCutoffDay at orderCutoffEnforceTime,
// then closed for the rest of the week (reopening the next Sunday).
function isWeeklyCutoffClosed(settings) {
  let cutoffDay = parseInt(String((settings && settings.orderCutoffDay) || '3'), 10);
  if (!(cutoffDay >= 0 && cutoffDay <= 6)) cutoffDay = 3;
  const today = israelWeekday();
  if (today < cutoffDay) return false;
  if (today > cutoffDay) return true;
  return israelNowMinutes() >= parseHHMM(settings && settings.orderCutoffEnforceTime, 6 * 60);
}

// GET ?order=<id>&token=<token> — read an order back so the customer can edit it.
async function handleGetEdit(req, res) {
  try {
    const orderId = String((req.query && req.query.order) || '').trim();
    const token = String((req.query && req.query.token) || '').trim();

    if (!orderId || !token) return res.status(400).json({ error: 'בקשה לא תקינה.' });

    const catalog = await readCatalog();
    const ordersOpen = Array.isArray(catalog.products) && catalog.products.length > 0;

    if (!ordersOpen) {
      return res.json({ ok: false, reason: 'closed', message: EDIT_REASON_MESSAGES.closed });
    }

    const result = await readOrderForEdit(orderId, token);

    if (!result.ok) {
      return res.json({ ok: false, reason: result.reason, message: EDIT_REASON_MESSAGES[result.reason] || 'לא ניתן לעדכן את ההזמנה.' });
    }

    return res.json({ ok: true, ...result.order });
  } catch (error) {
    console.error('Order edit read error:', error);
    return res.status(500).json({ error: 'שגיאה בטעינת ההזמנה.' });
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return handleGetEdit(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const isUpdate = Boolean(body.editOrderId && body.editToken);

    const catalog = await readCatalog();
    const settings = catalog.settings || {};

    if (isUpdate) {
      const ordersOpen = Array.isArray(catalog.products) && catalog.products.length > 0;
      if (!ordersOpen) {
        return res.status(409).json({ error: EDIT_REASON_MESSAGES.closed });
      }
    }

    const order = validateAndBuildOrder(body, catalog.products, settings);
    order.settings = settings;
    // Record the chosen payment method — credit only when the processor is live
    // (otherwise fall back to cash / pay-on-delivery).
    order.paymentMethod = (body.paymentMethod === 'credit' && paymentsEnabled()) ? 'credit' : 'cash';

    // Credit: tokenize was done in the browser; save the card on the processor
    // (card-on-file) so it can be charged for the final weighed amount at picking.
    if (order.paymentMethod === 'credit') {
      const token = String(body.paymentToken || '').trim();
      if (!token) {
        return res.status(400).json({ error: 'חסרים פרטי אשראי. נא להזין את פרטי הכרטיס ולנסות שוב.' });
      }
      const saved = await getPaymentAdapter().saveCard({
        singleUseToken: token,
        customer: { fullName: order.fullName, phone: order.phone, email: order.email },
      });
      if (!saved.ok) {
        return res.status(402).json({ error: 'לא הצלחנו לאמת את כרטיס האשראי. בדקו את הפרטים ונסו שוב.' });
      }
      order.payment = {
        method: 'credit',
        providerCustomerRef: saved.customerRef || '',
        cardExpiry: saved.cardExpiry || '',
        cardLast4: saved.cardLast4 || '',
        brand: saved.brand || '',
      };
    }

    // Reject time-limited items submitted after the weekly cutoff.
    if (isWeeklyCutoffClosed(settings)) {
      const cutoffIds = new Set((catalog.products || []).filter((p) => p.orderCutoff).map((p) => p.id));
      const closed = (order.items || [])
        .filter((it) => it.product && cutoffIds.has(it.product.id))
        .map((it) => it.product.name);
      if (closed.length) {
        const HEB_WEEKDAYS = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
        let cutoffDay = parseInt(String(settings.orderCutoffDay || '3'), 10);
        if (!(cutoffDay >= 0 && cutoffDay <= 6)) cutoffDay = 3;
        const disp = HEB_WEEKDAYS[cutoffDay] + ' ' + String(settings.orderCutoffDisplayTime || '03:00');
        return res.status(409).json({
          error: 'הפריטים הבאים ניתנים להזמנה רק עד ' + disp + ', ולא ניתן להזמין אותם כעת: '
            + closed.join(', ') + '. אפשר להסיר אותם ולשלוח שוב.',
        });
      }
    }

    let writeResult;

    if (isUpdate) {
      order.orderId = String(body.editOrderId).trim();
      order.isUpdate = true;
      writeResult = await updateOrderInPlace(order, body.editToken);
    } else {
      writeResult = await writeOrder(order);
    }

    const documentOrder = {
      ...order,
      timestamp: writeResult.timestamp,
    };

    try {
      await appendPickingOrder(documentOrder, order.items);
    } catch (error) {
      console.error('Picking sheet append failed:', error);
    }

    let pdfBuffer = null;
    let pdfError = '';

    try {
      pdfBuffer = await createOrderPdf(settings, documentOrder, order.items);
    } catch (error) {
      pdfError = error.message || 'יצירת PDF נכשלה.';
      console.error('Order PDF generation failed:', error);
    }

    // On an update, also build a "what changed" PDF for the business email.
    let changesPdfBuffer = null;
    if (isUpdate) {
      try {
        changesPdfBuffer = await createOrderChangesPdf(settings, documentOrder);
      } catch (error) {
        console.error('Order changes PDF generation failed:', error);
      }
    }

    const [customerEmailResult, businessEmailResult, telegramResult] = await Promise.all([
      sendCustomerOrderEmail(settings, documentOrder, order.items, pdfBuffer, pdfError, changesPdfBuffer),
      sendBusinessOrderEmail(settings, documentOrder, order.items, pdfBuffer, pdfError, changesPdfBuffer),
      sendTelegramOrder(settings, documentOrder, order.items, pdfBuffer, pdfError),
    ]);

    try {
      await updateOrderNotificationStatuses(order.orderId, writeResult.rowNumber, {
        customerEmail: customerEmailResult,
        businessEmail: businessEmailResult,
        telegram: telegramResult,
      });
    } catch (error) {
      console.error('Order notification status update failed:', error);
    }

    const skippedEmail = Boolean(customerEmailResult.skippedEmail || businessEmailResult.skippedEmail);
    const skippedEmailReason = [customerEmailResult.reason, businessEmailResult.reason]
      .filter(Boolean)
      .filter((reason, index, reasons) => reasons.indexOf(reason) === index)
      .join(' ');

    res.json({
      ok: true,
      success: true,
      updated: Boolean(order.isUpdate),
      skippedEmail,
      reason: skippedEmail ? skippedEmailReason : '',
      orderId: order.orderId,
      editToken: order.editToken || '',
      itemCount: order.items.length,
      estimatedTotal: order.estimatedTotal,
      deliveryFee: order.deliveryFee,
      grandTotal: order.grandTotal,
      unpricedItemCount: order.unpricedItemCount,
      estimatedWeightItemCount: order.estimatedWeightItemCount,
      customerEmailStatus: customerEmailResult.status,
      businessEmailStatus: businessEmailResult.status,
      telegramStatus: telegramResult.status,
    });
  } catch (error) {
    console.error('Order error:', error);
    const isValidation = error.message && !error.message.includes('sheets') && !error.message.includes('auth');
    res.status(isValidation ? 400 : 500).json({ error: error.message || 'שגיאה בשליחת ההזמנה.' });
  }
};
