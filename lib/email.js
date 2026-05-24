const { Resend } = require('resend');
const {
  buildAddressText,
  buildOrderPdfFilename,
  escapeHtml,
  formatEstimatedTotal,
  formatMoney,
  formatQuantity,
  getBillingNotice,
} = require('./order-pdf');

const SENT_STATUS = 'נשלח מ-Vercel';
const FAILED_STATUS = 'נכשל מ-Vercel';

let resendClient = null;

function getResendClient() {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();

  if (!apiKey) {
    throw new Error('RESEND_API_KEY לא מוגדר.');
  }

  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }

  return resendClient;
}

function getFromEmail() {
  return String(process.env.ORDER_FROM_EMAIL || 'orders@prinuk.co.il').trim();
}

function getCustomerReplyToEmail() {
  return String(process.env.ORDER_REPLY_TO_EMAIL || 'prinuk10@gmail.com').trim();
}

function splitRecipients(value) {
  return String(value || '')
    .split(/[,\n;]+/)
    .map(email => email.trim())
    .filter(Boolean);
}

function buildPdfAttachment(order, pdfBuffer) {
  if (!pdfBuffer) return null;

  return {
    filename: buildOrderPdfFilename(order),
    content: Buffer.from(pdfBuffer).toString('base64'),
    contentType: 'application/pdf',
  };
}

async function sendCustomerOrderEmail(settings, order, items, pdfBuffer, pdfError) {
  try {
    if (!order.email) {
      return { status: 'לא נמסר מייל', error: '' };
    }

    return await sendOrderEmail({
      to: [order.email],
      subject: 'ההזמנה שלך בפרינוק התקבלה - ' + order.orderId,
      text: buildCustomerText(order, items, settings),
      html: buildCustomerHtml(settings, order, items),
      replyTo: getCustomerReplyToEmail(),
      order,
      pdfBuffer,
      pdfError,
    });
  } catch (error) {
    return {
      status: FAILED_STATUS,
      error: error.message || 'שליחת מייל ללקוח נכשלה.',
    };
  }
}

async function sendBusinessOrderEmail(settings, order, items, pdfBuffer, pdfError) {
  try {
    const recipients = splitRecipients(settings.notificationEmails);

    if (!recipients.length) {
      return { status: 'לא הוגדר מייל', error: '' };
    }

    return await sendOrderEmail({
      to: recipients,
      subject: 'הזמנה חדשה מפרינוק - ' + order.fullName + ' - ' + order.orderId,
      text: buildBusinessText(order, items, settings),
      html: buildBusinessHtml(settings, order, items),
      replyTo: order.email || settings.contactEmail || '',
      order,
      pdfBuffer,
      pdfError,
    });
  } catch (error) {
    return {
      status: FAILED_STATUS,
      error: error.message || 'שליחת מייל פרינוק נכשלה.',
    };
  }
}

async function sendOrderEmail(options) {
  try {
    const attachment = buildPdfAttachment(options.order, options.pdfBuffer);
    const payload = {
      from: getFromEmail(),
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    };

    if (options.replyTo) {
      payload.replyTo = options.replyTo;
    }

    if (attachment) {
      payload.attachments = [attachment];
    }

    const { error } = await getResendClient().emails.send(payload);

    if (error) {
      throw new Error(formatResendError(error));
    }

    return {
      status: SENT_STATUS,
      error: attachment ? '' : formatMissingPdfError(options.pdfError),
    };
  } catch (error) {
    return {
      status: FAILED_STATUS,
      error: error.message || 'שליחת המייל נכשלה.',
    };
  }
}

function formatMissingPdfError(pdfError) {
  return 'המייל נשלח ללא PDF' + (pdfError ? ': ' + pdfError : '.');
}

function formatResendError(error) {
  if (!error) return 'שליחת המייל נכשלה.';
  if (typeof error === 'string') return error;
  return error.message || error.name || JSON.stringify(error);
}

function buildBusinessText(order, items, settings) {
  const lines = [
    'התקבלה הזמנה חדשה.',
    '',
    'מספר הזמנה: ' + order.orderId,
    'לקוח: ' + order.fullName,
    'טלפון: ' + order.phone,
    order.email ? 'מייל לקוח: ' + order.email : '',
    'שיטת הזמנה: ' + order.fulfillment,
    'כתובת/איסוף: ' + buildAddressText({ ...order, settings }),
    'סכום משוער: ' + formatEstimatedTotal(order.estimatedTotal, order.unpricedItemCount),
    getBillingNotice(),
    order.notes ? 'הערות: ' + order.notes : '',
    '',
    'מוצרים:',
  ].filter(line => line !== '');

  appendItemText(lines, items);
  return lines.join('\n');
}

function buildCustomerText(order, items, settings) {
  const lines = [
    'שלום ' + order.fullName + ',',
    '',
    'ההזמנה שלך בפרינוק התקבלה בהצלחה.',
    'מספר הזמנה: ' + order.orderId,
    'שיטת הזמנה: ' + order.fulfillment,
    'כתובת/איסוף: ' + buildAddressText({ ...order, settings }),
    'סכום משוער: ' + formatEstimatedTotal(order.estimatedTotal, order.unpricedItemCount),
    getBillingNotice(),
    '',
    'מוצרים:',
  ];

  appendItemText(lines, items);
  lines.push('');
  lines.push('מצורף PDF עם פרטי ההזמנה.');
  lines.push('תודה, פרינוק');
  return lines.join('\n');
}

function appendItemText(lines, items) {
  (items || []).forEach(line => {
    const total = typeof line.lineTotal === 'number' ? formatMoney(line.lineTotal) : 'לפי חישוב בפועל';
    const note = getLineNote(line);
    lines.push('- ' + line.product.name + ': ' + formatQuantity(line.quantity) + ' ' + formatUnitLabel(line.orderUnit) + ' | ' + total);

    if (note) {
      lines.push('  הערת מוצר: ' + note);
    }
  });
}

function getLineNote(line) {
  return String(line && (line.note || line.comment || line.comments || line.itemNote || line.productNote) || '').trim();
}

function formatUnitLabel(value) {
  const text = String(value || '').trim();
  const compact = text.replace(/[״"]/g, '"').replace(/\s+/g, '');

  if (compact === 'קג' || compact === 'ק"ג') {
    return 'ק״ג';
  }

  return text;
}

function buildBusinessHtml(settings, order, items) {
  return buildOrderEmailHtml(
    settings,
    'התקבלה הזמנה חדשה',
    'התקבלה הזמנה חדשה בפרינוק.',
    order,
    items
  );
}

function buildCustomerHtml(settings, order, items) {
  return buildOrderEmailHtml(
    settings,
    'ההזמנה שלך התקבלה',
    'שלום ' + order.fullName + ', ההזמנה שלך בפרינוק התקבלה בהצלחה.',
    order,
    items
  );
}

function buildOrderEmailHtml(settings, title, intro, order, items) {
  const contactText = buildContactText(settings);
  const logoUrl = String(settings.logoUrl || '').trim();
  const rows = (items || []).map(line => {
    const total = typeof line.lineTotal === 'number' ? formatMoney(line.lineTotal) : 'לפי חישוב בפועל';
    const note = getLineNote(line);

    return [
      '<tr>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;font-weight:bold;">', escapeHtml(line.product.name), '</td>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;">', escapeHtml(formatQuantity(line.quantity)), '</td>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;">', escapeHtml(formatUnitLabel(line.orderUnit)), '</td>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;">', escapeHtml(total), '</td>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;white-space:pre-wrap;">', note ? escapeHtml(note) : '-', '</td>',
      '</tr>',
    ].join('');
  }).join('');
  const logoHtml = logoUrl
    ? '<img src="' + escapeHtml(logoUrl) + '" alt="פרינוק" width="76" height="76" style="display:block;width:76px;height:76px;object-fit:contain;border:0;">'
    : '';

  return [
    '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#1e2528;line-height:1.45;background:#ffffff;">',
    '<div style="max-width:720px;margin:0 auto;padding:18px;">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-bottom:3px solid #1f7a5a;margin-bottom:18px;">',
    '<tr>',
    '<td style="width:92px;padding:0 0 12px;text-align:center;vertical-align:middle;">', logoHtml, '</td>',
    '<td style="padding:0 12px 12px;text-align:center;vertical-align:middle;">',
    '<div style="font-size:26px;font-weight:800;color:#1e2528;">', escapeHtml(title), '</div>',
    '<div style="font-size:15px;font-weight:700;color:#165a43;margin-top:4px;">פרינוק - המכירה השבועית</div>',
    contactText ? '<div style="font-size:13px;font-weight:700;color:#165a43;margin-top:4px;">' + escapeHtml(contactText) + '</div>' : '',
    '</td>',
    '</tr>',
    '</table>',
    '<p style="font-size:16px;font-weight:700;margin:0 0 14px;">', escapeHtml(intro), '</p>',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f7f6f1;border:1px solid #d9ded6;border-radius:8px;margin-bottom:14px;">',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">מספר הזמנה:</td><td style="padding:8px;">', escapeHtml(order.orderId), '</td></tr>',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">לקוח:</td><td style="padding:8px;">', escapeHtml(order.fullName), '</td></tr>',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">טלפון:</td><td style="padding:8px;">', escapeHtml(order.phone), '</td></tr>',
    order.email ? '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">מייל:</td><td style="padding:8px;">' + escapeHtml(order.email) + '</td></tr>' : '',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">שיטת הזמנה:</td><td style="padding:8px;">', escapeHtml(order.fulfillment), '</td></tr>',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">כתובת/איסוף:</td><td style="padding:8px;">', escapeHtml(buildAddressText({ ...order, settings })), '</td></tr>',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">סכום משוער:</td><td style="padding:8px;font-weight:800;color:#165a43;">', escapeHtml(formatEstimatedTotal(order.estimatedTotal, order.unpricedItemCount)), '</td></tr>',
    '</table>',
    '<div style="border:1px solid #d7e5db;background:#e5f2ec;color:#165a43;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-weight:bold;">', escapeHtml(getBillingNotice()), '</div>',
    order.notes ? '<div style="border:1px solid #d9ded6;border-radius:8px;padding:10px 12px;margin-bottom:14px;"><b style="color:#165a43;">הערות:</b><br>' + escapeHtml(order.notes) + '</div>' : '',
    '<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:12px;">',
    '<thead><tr>',
    '<th style="border:1px solid #1f7a5a;background:#1f7a5a;color:#ffffff;padding:8px;text-align:right;">מוצר</th>',
    '<th style="border:1px solid #1f7a5a;background:#1f7a5a;color:#ffffff;padding:8px;text-align:right;">כמות</th>',
    '<th style="border:1px solid #1f7a5a;background:#1f7a5a;color:#ffffff;padding:8px;text-align:right;">יחידה</th>',
    '<th style="border:1px solid #1f7a5a;background:#1f7a5a;color:#ffffff;padding:8px;text-align:right;">סכום</th>',
    '<th style="border:1px solid #1f7a5a;background:#1f7a5a;color:#ffffff;padding:8px;text-align:right;">הערת מוצר</th>',
    '</tr></thead>',
    '<tbody>', rows, '</tbody>',
    '</table>',
    '<p style="margin:16px 0 0;color:#667074;">מצורף PDF עם פרטי ההזמנה.</p>',
    '</div>',
    '</div>',
  ].join('');
}

function buildContactText(settings) {
  const parts = [];

  if (settings.contactPhone) parts.push(settings.contactPhone);
  if (settings.contactEmail) parts.push(settings.contactEmail);

  return parts.join(' | ');
}

module.exports = {
  sendBusinessOrderEmail,
  sendCustomerOrderEmail,
};
