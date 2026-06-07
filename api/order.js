const {
  appendPickingOrder,
  readCatalog,
  readOrderForEdit,
  updateOrderInPlace,
  updateOrderNotificationStatuses,
  validateAndBuildOrder,
  writeOrder,
} = require('../lib/sheets');
const { sendBusinessOrderEmail, sendCustomerOrderEmail } = require('../lib/email');
const { createOrderPdf, createOrderChangesPdf } = require('../lib/order-pdf');
const { sendTelegramOrder } = require('../lib/telegram');

const EDIT_REASON_MESSAGES = {
  notfound: 'לא מצאנו את ההזמנה. ייתכן שכבר נסגרה.',
  token: 'הקישור לעריכת ההזמנה אינו תקין.',
  locked: 'ההזמנה כבר בטיפול ולא ניתן לעדכן אותה. אפשר ליצור קשר ונשמח לעזור.',
  closed: 'ההזמנות סגורות כרגע, לכן לא ניתן לעדכן את ההזמנה.',
};

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

    const order = validateAndBuildOrder(body, catalog.products);
    order.settings = settings;

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
      sendCustomerOrderEmail(settings, documentOrder, order.items, pdfBuffer, pdfError),
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
