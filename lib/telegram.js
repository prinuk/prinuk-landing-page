const {
  buildAddressText,
  buildOrderPdfFilename,
  formatEstimatedTotal,
  formatOrderChangesLines,
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
    '<b>' + (order.isUpdate ? '🔄 הזמנה עודכנה בפרינוּק' : 'הזמנה חדשה בפרינוּק') + '</b>',
    'מספר הזמנה: ' + escapeTelegramHtml(order.orderId),
    'לקוח: ' + escapeTelegramHtml(order.fullName),
    'טלפון: ' + escapeTelegramHtml(order.phone),
    'שיטת הזמנה: ' + escapeTelegramHtml(order.fulfillment),
    'סכום משוער: ' + escapeTelegramHtml(formatEstimatedTotal(order.estimatedTotal, order.unpricedItemCount, order.deliveryFee)),
    'מספר שורות: ' + escapeTelegramHtml(String((items || []).length)),
    '',
  ];

  if (order.fulfillment === 'משלוח') {
    lines.push('כתובת: ' + escapeTelegramHtml(buildAddressText({ ...order, settings })));
  }

  if (order.notes) {
    lines.push('הערות: ' + escapeTelegramHtml(order.notes));
  }

  if (order.isUpdate) {
    const changeLines = formatOrderChangesLines(order);
    lines.push('');
    lines.push('<b>🔄 מה השתנה בהזמנה:</b>');
    if (changeLines.length) {
      changeLines.forEach(line => lines.push(escapeTelegramHtml(line)));
    } else {
      lines.push('לא זוהו שינויים בפריטים.');
    }
  }

  lines.push('');
  lines.push(escapeTelegramHtml(getBillingNotice()));

  return lines.join('\n');
}

function buildTelegramDocumentCaption(order, items) {
  return [
    '<b>' + (order.isUpdate ? 'PDF להזמנה מעודכנת' : 'PDF להזמנה חדשה') + '</b>',
    'מספר הזמנה: ' + escapeTelegramHtml(order.orderId),
    'לקוח: ' + escapeTelegramHtml(order.fullName),
    'שורות: ' + escapeTelegramHtml(String((items || []).length)),
  ].join('\n');
}

// --- Collected/picked-order summary → its own Telegram channel ---
// Uses the SAME bot token, a separate chat id (settings.telegramPickedChatId).
// Best-effort: never throws (a notification must not fail the collect action).
async function sendPickedOrderTelegram(settings, order, pdfBuffer) {
  const token = String((settings && settings.telegramBotToken) || '').trim();
  const chatId = String((settings && settings.telegramPickedChatId) || '').trim();
  if (!token || !chatId) return { sent: false, reason: 'not-configured' };

  try {
    await sendTelegramMessage(token, chatId, buildPickedOrderMessage(order));
    if (pdfBuffer) {
      const form = new FormData();
      form.append('chat_id', chatId);
      // ASCII-only filename: a Hebrew prefix + LTR order code gets bidi-mangled
      // in the Telegram UI.
      form.append('document', new Blob([pdfBuffer], { type: 'application/pdf' }),
        'order-' + String(order.orderId || '') + '.pdf');
      await postTelegram(token, 'sendDocument', form);
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error.message || 'telegram-failed' };
  }
}

function buildPickedOrderMessage(order) {
  const items = order.items || [];
  const missing = items.filter((it) => it.pickStatus === 'חסר').map((it) => it.name);
  const hasActual = order.actualTotal !== '' && order.actualTotal != null && Number(order.actualTotal) > 0;

  const lines = [
    '<b>📦 הזמנה נאספה — פרינוּק</b>',
    'מספר הזמנה: ' + escapeTelegramHtml(order.orderId),
    'לקוח: ' + escapeTelegramHtml(order.fullName),
    'טלפון: ' + escapeTelegramHtml(order.phone),
    'אופן מסירה: ' + escapeTelegramHtml(order.fulfillment || ''),
  ];
  if (order.fulfillment === 'משלוח' && order.addressText) {
    lines.push('כתובת: ' + escapeTelegramHtml(order.addressText));
  }
  lines.push(hasActual
    ? 'סה״כ סופי: ' + escapeTelegramHtml('₪' + order.actualTotal)
    : 'סה״כ משוער: ' + escapeTelegramHtml(order.totalText || ''));
  lines.push('');
  if (missing.length) {
    lines.push('<b>⚠️ פריטים חסרים (' + missing.length + '):</b>');
    missing.forEach((name) => lines.push('• ' + escapeTelegramHtml(name)));
  } else {
    lines.push('✅ כל הפריטים נאספו.');
  }
  return lines.join('\n');
}

function escapeTelegramHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  sendTelegramOrder,
  sendPickedOrderTelegram,
};
