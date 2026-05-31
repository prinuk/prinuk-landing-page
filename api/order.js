const {
  appendPickingOrder,
  readCatalog,
  updateOrderNotificationStatuses,
  validateAndBuildOrder,
  writeOrder,
} = require('../lib/sheets');
const { sendBusinessOrderEmail, sendCustomerOrderEmail } = require('../lib/email');
const { createOrderPdf } = require('../lib/order-pdf');
const { sendTelegramOrder } = require('../lib/telegram');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const catalog = await readCatalog();
    const settings = catalog.settings || {};
    const order = validateAndBuildOrder(req.body, catalog.products);
    order.settings = settings;

    const writeResult = await writeOrder(order);
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

    const [customerEmailResult, businessEmailResult, telegramResult] = await Promise.all([
      sendCustomerOrderEmail(settings, documentOrder, order.items, pdfBuffer, pdfError),
      sendBusinessOrderEmail(settings, documentOrder, order.items, pdfBuffer, pdfError),
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
      skippedEmail,
      reason: skippedEmail ? skippedEmailReason : '',
      orderId: order.orderId,
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
