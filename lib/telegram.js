const {
  buildAddressText,
  buildOrderPdfFilename,
  formatEstimatedTotal,
  getBillingNotice,
} = require('./order-pdf');

const SENT_STATUS = 'נשלח מ-Vercel';
const FAILED_STATUS = 'נכשל מ-Vercel';

async function sendTelegramOrder(settings, order, items, pdfBuffer, pdfError) {
  const token = String(settings.telegramBotToken || '').trim();
  const chatId = String(settings.telegramChatId || '').trim();

  if (!token || !chatId) {
    return { status: 'לא הוגדר טלגרם', error: '' };
  }

  try {
    await sendTelegramMessage(token, chatId, buildNewOrderTelegramMessage(settings, order, items));

    if (!pdfBuffer) {
      return {
        status: SENT_STATUS,
        error: 'הודעת טלגרם נשלחה ללא PDF' + (pdfError ? ': ' + pdfError : '.'),
      };
    }

    try {
      await sendTelegramDocument(token, chatId, order, items, pdfBuffer);
    } catch (documentError) {
      return {
        status: SENT_STATUS,
        error: 'הודעת טלגרם נשלחה, אבל שליחת ה-PDF נכשלה: ' + (documentError.message || 'לא ידוע'),
      };
    }

    return { status: SENT_STATUS, error: '' };
  } catch (error) {
    return {
      status: FAILED_STATUS,
      error: error.message || 'שליחת טלגרם נכשלה.',
    };
  }
}

async function sendTelegramMessage(token, chatId, message) {
  const body = new URLSearchParams({
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: 'true',
  });

  await postTelegram(token, 'sendMessage', body);
}

async function sendTelegramDocument(token, chatId, order, items, pdfBuffer) {
  const form = new FormData();

  form.append('chat_id', chatId);
  form.append('caption', buildTelegramDocumentCaption(order, items));
  form.append('parse_mode', 'HTML');
  form.append('document', new Blob([pdfBuffer], { type: 'application/pdf' }), buildOrderPdfFilename(order));

  await postTelegram(token, 'sendDocument', form);
}

async function postTelegram(token, method, body) {
  const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    body,
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error('Telegram HTTP ' + response.status + ': ' + text);
  }

  let parsed = null;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('Telegram returned invalid JSON: ' + text);
  }

  if (!parsed.ok) {
    throw new Error('Telegram rejected request: ' + text);
  }
}

function buildNewOrderTelegramMessage(settings, order, items) {
  const lines = [
    '<b>הזמנה חדשה בפרינוק</b>',
    'מספר הזמנה: ' + escapeTelegramHtml(order.orderId),
    'לקוח: ' + escapeTelegramHtml(order.fullName),
    'טלפון: ' + escapeTelegramHtml(order.phone),
    'שיטת הזמנה: ' + escapeTelegramHtml(order.fulfillment),
    'סכום משוער: ' + escapeTelegramHtml(formatEstimatedTotal(order.estimatedTotal, order.unpricedItemCount)),
    'מספר שורות: ' + escapeTelegramHtml(String((items || []).length)),
    '',
  ];

  if (order.fulfillment === 'משלוח') {
    lines.push('כתובת: ' + escapeTelegramHtml(buildAddressText({ ...order, settings })));
  }

  if (order.notes) {
    lines.push('הערות: ' + escapeTelegramHtml(order.notes));
  }

  lines.push(escapeTelegramHtml(getBillingNotice()));

  return lines.join('\n');
}

function buildTelegramDocumentCaption(order, items) {
  return [
    '<b>PDF להזמנה חדשה</b>',
    'מספר הזמנה: ' + escapeTelegramHtml(order.orderId),
    'לקוח: ' + escapeTelegramHtml(order.fullName),
    'שורות: ' + escapeTelegramHtml(String((items || []).length)),
  ].join('\n');
}

function escapeTelegramHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  sendTelegramOrder,
};
