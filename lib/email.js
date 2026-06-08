const { get: getEdgeConfigValue } = require('@vercel/edge-config');
const { Resend } = require('resend');
const {
  CUSTOMER_FRESHNESS_NOTICE_LINES,
  buildAddressText,
  buildOrderPdfFilename,
  buildOrderChangesFilename,
  escapeHtml,
  formatEstimatedWeightNote,
  formatEstimatedTotal,
  formatLineAmount,
  formatLineQuantity,
  formatLineTotal,
  formatOrderChangesLines,
  getBillingNotice,
} = require('./order-pdf');

const SENT_STATUS = 'נשלח מ-Vercel';
const FAILED_STATUS = 'נכשל מ-Vercel';
const SKIPPED_STATUS = 'מייל כבוי ב-Edge Config';
const PRODUCTION_EMAIL_FLAG = 'sendEmailsProduction';
const PREVIEW_EMAIL_FLAG = 'sendEmailsPreview';

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
  return 'פרינוּק <orders@prinuk.co.il>';
}

function getOrderSiteBaseUrl() {
  return String(process.env.PUBLIC_ORDER_URL || 'https://order.prinuk.co.il').trim().replace(/\/+$/, '');
}

// Emailed "edit your order" magic link, gated server-side by the order's token.
function buildEditOrderUrl(order) {
  if (!order || !order.orderId || !order.editToken) return '';
  return getOrderSiteBaseUrl() + '/?order=' + encodeURIComponent(order.orderId) + '&token=' + encodeURIComponent(order.editToken);
}

function getCustomerReplyToEmail() {
  return 'prinuk10@gmail.com';
}

function splitRecipients(value) {
  return String(value || '')
    .split(/[,\n;]+/)
    .map(email => email.trim())
    .filter(Boolean);
}

function buildNamedPdfAttachment(filename, pdfBuffer) {
  if (!pdfBuffer) return null;

  return {
    filename,
    content: Buffer.from(pdfBuffer).toString('base64'),
    contentType: 'application/pdf',
  };
}

function buildPdfAttachment(order, pdfBuffer) {
  return buildNamedPdfAttachment(buildOrderPdfFilename(order), pdfBuffer);
}

async function sendCustomerOrderEmail(settings, order, items, pdfBuffer, pdfError, changesPdfBuffer) {
  try {
    if (!order.email) {
      return { status: 'לא נמסר מייל', error: '' };
    }

    const extraAttachments = [];
    if (order.isUpdate && changesPdfBuffer) {
      extraAttachments.push({ filename: buildOrderChangesFilename(order), buffer: changesPdfBuffer });
    }

    return await sendOrderEmail({
      to: [order.email],
      subject: (order.isUpdate ? 'ההזמנה שלך בפרינוּק עודכנה - ' : 'ההזמנה שלך בפרינוּק התקבלה - ') + order.orderId,
      text: buildCustomerText(order, items, settings),
      html: buildCustomerHtml(settings, order, items),
      replyTo: getCustomerReplyToEmail(),
      order,
      pdfBuffer,
      pdfError,
      extraAttachments,
    });
  } catch (error) {
    return {
      status: FAILED_STATUS,
      error: error.message || 'שליחת מייל ללקוח נכשלה.',
    };
  }
}

async function sendBusinessOrderEmail(settings, order, items, pdfBuffer, pdfError, changesPdfBuffer) {
  try {
    const recipients = splitRecipients(settings.notificationEmails);

    if (!recipients.length) {
      return { status: 'לא הוגדר מייל', error: '' };
    }

    const extraAttachments = [];
    if (order.isUpdate && changesPdfBuffer) {
      extraAttachments.push({ filename: buildOrderChangesFilename(order), buffer: changesPdfBuffer });
    }

    return await sendOrderEmail({
      to: recipients,
      subject: (order.isUpdate ? 'הזמנה עודכנה בפרינוּק - ' : 'הזמנה חדשה מפרינוּק - ') + order.fullName + ' - ' + order.orderId,
      text: buildBusinessText(order, items, settings),
      html: buildBusinessHtml(settings, order, items),
      replyTo: order.email || settings.contactEmail || '',
      order,
      pdfBuffer,
      pdfError,
      extraAttachments,
    });
  } catch (error) {
    return {
      status: FAILED_STATUS,
      error: error.message || 'שליחת מייל פרינוּק נכשלה.',
    };
  }
}

async function sendOrderEmail(options, dependencies) {
  try {
    const emailDecision = await shouldSendEmails(dependencies);

    if (!emailDecision.enabled) {
      return {
        status: SKIPPED_STATUS,
        error: '',
        success: true,
        skippedEmail: true,
        reason: emailDecision.reason,
        emailEnvironment: emailDecision.environment,
        emailFlagName: emailDecision.flagName,
      };
    }

    const attachments = [];
    const mainAttachment = buildPdfAttachment(options.order, options.pdfBuffer);
    if (mainAttachment) {
      attachments.push(mainAttachment);
    }
    (options.extraAttachments || []).forEach(extra => {
      const att = buildNamedPdfAttachment(extra.filename, extra.buffer);
      if (att) attachments.push(att);
    });

    const payload = {
      from: getFromEmail(),
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
      replyTo: getCustomerReplyToEmail(),
    };

    if (attachments.length) {
      payload.attachments = attachments;
    }

    const resend = dependencies && dependencies.resendClient || getResendClient();
    const { error } = await resend.emails.send(payload);

    if (error) {
      throw new Error(formatResendError(error));
    }

    return {
      status: SENT_STATUS,
      error: attachment ? '' : formatMissingPdfError(options.pdfError),
      success: true,
      skippedEmail: false,
    };
  } catch (error) {
    return {
      status: FAILED_STATUS,
      error: error.message || 'שליחת המייל נכשלה.',
      success: false,
      skippedEmail: false,
    };
  }
}

function getEmailEnvironment(env) {
  const detected = String((env || process.env).VERCEL_TARGET_ENV || (env || process.env).VERCEL_ENV || 'development').trim();
  return detected === 'production' ? 'production' : 'preview';
}

function getEmailFlagName(environment) {
  return environment === 'production' ? PRODUCTION_EMAIL_FLAG : PREVIEW_EMAIL_FLAG;
}

async function shouldSendEmails(options) {
  const env = options && options.env || process.env;
  const edgeConfigGet = options && options.edgeConfigGet || getEdgeConfigValue;
  const environment = getEmailEnvironment(env);
  const flagName = getEmailFlagName(environment);

  try {
    const value = await edgeConfigGet(flagName);
    const enabled = value === true;
    const reason = enabled
      ? ''
      : 'Email sending is disabled by Edge Config flag ' + flagName + '.';

    console.log('[email-toggle] environment=' + environment + ' flag=' + flagName + ' enabled=' + enabled);

    return {
      enabled,
      environment,
      flagName,
      reason,
    };
  } catch (error) {
    console.error('[email-toggle] Edge Config read failed:', error);
    console.log('[email-toggle] environment=' + environment + ' flag=' + flagName + ' enabled=false');

    return {
      enabled: false,
      environment,
      flagName,
      reason: 'Email sending is disabled because Edge Config could not be read.',
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
    order.isUpdate ? 'הזמנה עודכנה.' : 'התקבלה הזמנה חדשה.',
    '',
    'מספר הזמנה: ' + order.orderId,
    'לקוח: ' + order.fullName,
    'טלפון: ' + order.phone,
    order.email ? 'מייל לקוח: ' + order.email : '',
    'שיטת הזמנה: ' + order.fulfillment,
    'כתובת/איסוף: ' + buildAddressText({ ...order, settings }),
    'סכום משוער: ' + formatEstimatedTotal(order.estimatedTotal, order.unpricedItemCount, order.deliveryFee),
    getBillingNotice(),
    order.notes ? 'הערות: ' + order.notes : '',
  ].filter(line => line !== '');

  if (order.isUpdate) {
    const changeLines = formatOrderChangesLines(order);
    lines.push('');
    lines.push('🔄 מה השתנה בהזמנה:');
    if (changeLines.length) {
      changeLines.forEach(line => lines.push(line));
    } else {
      lines.push('לא זוהו שינויים בפריטים.');
    }
  }

  const editUrl = buildEditOrderUrl(order);
  if (editUrl) {
    lines.push('');
    lines.push('קישור לעריכת ההזמנה (לשימוש הצוות, עד סגירת ההזמנות):');
    lines.push(editUrl);
  }

  lines.push('');
  lines.push('מוצרים:');

  appendItemText(lines, items);
  return lines.join('\n');
}

function buildCustomerText(order, items, settings) {
  const editUrl = buildEditOrderUrl(order);
  const lines = [
    'שלום ' + order.fullName + ',',
    '',
    order.isUpdate ? 'ההזמנה שלך בפרינוּק עודכנה בהצלחה.' : 'ההזמנה שלך בפרינוּק התקבלה בהצלחה.',
    'מספר הזמנה: ' + order.orderId,
    'שיטת הזמנה: ' + order.fulfillment,
    'כתובת/איסוף: ' + buildAddressText({ ...order, settings }),
    'סכום משוער: ' + formatEstimatedTotal(order.estimatedTotal, order.unpricedItemCount, order.deliveryFee),
    getBillingNotice(),
    '',
    ...CUSTOMER_FRESHNESS_NOTICE_LINES,
  ];

  if (order.isUpdate) {
    const changeLines = formatOrderChangesLines(order);
    lines.push('');
    lines.push('🔄 מה עודכן בהזמנה שלך:');
    if (changeLines.length) {
      changeLines.forEach(line => lines.push(line));
    } else {
      lines.push('לא זוהו שינויים בפריטים.');
    }
  }

  lines.push('');
  lines.push('מוצרים:');
  appendItemText(lines, items);
  lines.push('');

  if (editUrl) {
    lines.push('צריך לשנות משהו? אפשר לעדכן את ההזמנה עד סגירת ההזמנות:');
    lines.push(editUrl);
    lines.push('');
  }

  lines.push('מצורף PDF עם פרטי ההזמנה.');
  lines.push('תודה, פרינוּק');
  return lines.join('\n');
}

function appendItemText(lines, items) {
  (items || []).forEach(line => {
    const total = formatLineTotal(line);
    const note = getLineNote(line);
    const estimatedWeightNote = formatEstimatedWeightNote(line);
    lines.push('- ' + line.product.name + ': ' + formatLineAmount(line) + ' | ' + total);

    if (note) {
      lines.push('  הערת מוצר: ' + note);
    }

    if (estimatedWeightNote) {
      lines.push('  ' + estimatedWeightNote);
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
    return 'ק"ג';
  }

  return text;
}

function buildBusinessHtml(settings, order, items) {
  const options = {
    editUrl: buildEditOrderUrl(order),
    editCaption: 'קישור לעריכת ההזמנה (לשימוש הצוות, עד סגירת ההזמנות):',
  };
  if (order.isUpdate) {
    options.changesHtml = buildChangesEmailHtml(order, 'מה השתנה בהזמנה');
  }
  return buildOrderEmailHtml(
    settings,
    order.isUpdate ? 'הזמנה עודכנה' : 'התקבלה הזמנה חדשה',
    order.isUpdate ? 'הזמנה עודכנה בפרינוּק.' : 'התקבלה הזמנה חדשה בפרינוּק.',
    order,
    items,
    options
  );
}

function buildChangesEmailHtml(order, heading) {
  const lines = formatOrderChangesLines(order);
  const inner = lines.length
    ? lines.map(l => '<div style="margin-bottom:4px;">' + escapeHtml(l) + '</div>').join('')
    : '<div>לא זוהו שינויים בפריטים.</div>';

  return [
    '<div style="border:1px solid #e3c98a;background:#fff8e6;color:#7a5b00;border-radius:8px;padding:10px 12px;margin-bottom:14px;">',
    '<div style="font-weight:800;margin-bottom:6px;">🔄 ', escapeHtml(heading || 'מה השתנה בהזמנה'), '</div>',
    inner,
    '<div style="font-size:13px;color:#9a7b2a;margin-top:6px;">מצורף גם PDF עם פירוט השינויים.</div>',
    '</div>',
  ].join('');
}

function buildCustomerHtml(settings, order, items) {
  return buildOrderEmailHtml(
    settings,
    order.isUpdate ? 'ההזמנה שלך עודכנה' : 'ההזמנה שלך התקבלה',
    'שלום ' + order.fullName + ', ההזמנה שלך בפרינוּק ' + (order.isUpdate ? 'עודכנה בהצלחה.' : 'התקבלה בהצלחה.'),
    order,
    items,
    {
      includeFreshnessNotice: true,
      editUrl: buildEditOrderUrl(order),
      changesHtml: order.isUpdate ? buildChangesEmailHtml(order, 'מה עודכן בהזמנה שלך') : '',
    }
  );
}

function buildEditOrderButtonHtml(editUrl, caption) {
  return [
    '<div style="text-align:center;margin-bottom:16px;">',
    '<div style="font-size:14px;color:#445;margin-bottom:8px;">', escapeHtml(caption || 'צריך לשנות משהו? אפשר לעדכן את ההזמנה עד סגירת ההזמנות.'), '</div>',
    '<a href="', escapeHtml(editUrl), '" style="display:inline-block;background:#0c4c9c;color:#ffffff;text-decoration:none;font-weight:800;padding:11px 22px;border-radius:999px;">עריכת ההזמנה</a>',
    '</div>',
  ].join('');
}

function buildFreshnessNoticeHtml() {
  return [
    '<div style="border:1px solid #d7e5db;background:#f4faf6;color:#165a43;border-radius:8px;padding:10px 12px;margin-bottom:14px;">',
    '<div style="font-weight:800;margin-bottom:6px;">', escapeHtml(CUSTOMER_FRESHNESS_NOTICE_LINES[0]), '</div>',
    '<div style="font-size:14px;margin-bottom:6px;">', escapeHtml(CUSTOMER_FRESHNESS_NOTICE_LINES[1]), '</div>',
    '<div style="font-size:14px;">', escapeHtml(CUSTOMER_FRESHNESS_NOTICE_LINES[2]), '</div>',
    '</div>',
  ].join('');
}

function buildOrderEmailHtml(settings, title, intro, order, items, options = {}) {
  const contactText = buildContactText(settings);
  const logoUrl = String(settings.logoUrl || '').trim();
  const rows = (items || []).map(line => {
    const total = formatLineTotal(line);
    const note = getLineNote(line);

    return [
      '<tr>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;font-weight:bold;">', escapeHtml(line.product.name), '</td>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;">', escapeHtml(formatLineQuantity(line)), '</td>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;">', escapeHtml(formatUnitLabel(line.orderUnit)), '</td>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;">', escapeHtml(total), '</td>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;white-space:pre-wrap;">', note ? escapeHtml(note) : '-', '</td>',
      '</tr>',
    ].join('');
  }).join('');
  const logoHtml = logoUrl
    ? '<img src="' + escapeHtml(logoUrl) + '" alt="פרינוּק" width="76" height="76" style="display:block;width:76px;height:76px;object-fit:contain;border:0;">'
    : '';

  return [
    '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#1e2528;line-height:1.45;background:#ffffff;">',
    '<div style="max-width:720px;margin:0 auto;padding:18px;">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-bottom:3px solid #1f7a5a;margin-bottom:18px;">',
    '<tr>',
    '<td style="width:92px;padding:0 0 12px;text-align:center;vertical-align:middle;">', logoHtml, '</td>',
    '<td style="padding:0 12px 12px;text-align:center;vertical-align:middle;">',
    '<div style="font-size:26px;font-weight:800;color:#1e2528;">', escapeHtml(title), '</div>',
    '<div style="font-size:15px;font-weight:700;color:#165a43;margin-top:4px;">פרינוּק - המכירה השבועית</div>',
    contactText ? '<div style="font-size:13px;font-weight:700;color:#165a43;margin-top:4px;">' + escapeHtml(contactText) + '</div>' : '',
    '</td>',
    '</tr>',
    '</table>',
    '<p style="font-size:16px;font-weight:700;margin:0 0 14px;">', escapeHtml(intro), '</p>',
    options.changesHtml || '',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f7f6f1;border:1px solid #d9ded6;border-radius:8px;margin-bottom:14px;">',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">מספר הזמנה:</td><td style="padding:8px;">', escapeHtml(order.orderId), '</td></tr>',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">לקוח:</td><td style="padding:8px;">', escapeHtml(order.fullName), '</td></tr>',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">טלפון:</td><td style="padding:8px;">', escapeHtml(order.phone), '</td></tr>',
    order.email ? '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">מייל:</td><td style="padding:8px;">' + escapeHtml(order.email) + '</td></tr>' : '',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">שיטת הזמנה:</td><td style="padding:8px;">', escapeHtml(order.fulfillment), '</td></tr>',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">כתובת/איסוף:</td><td style="padding:8px;">', escapeHtml(buildAddressText({ ...order, settings })), '</td></tr>',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">סכום משוער:</td><td style="padding:8px;font-weight:800;color:#165a43;">', escapeHtml(formatEstimatedTotal(order.estimatedTotal, order.unpricedItemCount, order.deliveryFee)), '</td></tr>',
    '</table>',
    '<div style="border:1px solid #d7e5db;background:#e5f2ec;color:#165a43;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-weight:bold;">', escapeHtml(getBillingNotice()), '</div>',
    options.editUrl ? buildEditOrderButtonHtml(options.editUrl, options.editCaption) : '',
    options.includeFreshnessNotice ? buildFreshnessNoticeHtml() : '',
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
  buildBusinessHtml,
  buildBusinessText,
  buildCustomerHtml,
  buildCustomerText,
  getEmailEnvironment,
  getEmailFlagName,
  sendBusinessOrderEmail,
  sendCustomerOrderEmail,
  sendOrderEmail,
  shouldSendEmails,
};
