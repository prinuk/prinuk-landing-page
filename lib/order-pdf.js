const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

function getBillingNotice() {
  return 'הסכום המוצג הוא הערכה בלבד. החיוב הסופי יתבצע בשעת ליקוט ההזמנה, לפי המשקל והכמויות בפועל.';
}

function buildAddressText(order) {
  if (order.fulfillment !== 'משלוח') {
    return (order.settings && order.settings.pickupText) || order.pickupText || 'איסוף עצמי';
  }

  const parts = [order.address];

  if (order.floor) parts.push('קומה ' + order.floor);
  if (order.apartment) parts.push('דירה ' + order.apartment);

  return parts.filter(Boolean).join(', ');
}

function formatEstimatedTotal(total, unpricedItemCount) {
  const base = formatMoney(total || 0);

  if (Number(unpricedItemCount || 0) > 0) {
    return base + ' + ' + unpricedItemCount + ' פריטים לפי חישוב בפועל';
  }

  return base;
}

function formatQuantity(value) {
  const number = Number(value || 0);

  if (Math.abs(number - Math.round(number)) < 0.000001) {
    return String(Math.round(number));
  }

  return String(number).replace(/0+$/, '').replace(/\.$/, '');
}

function formatMoney(value) {
  return '₪' + formatQuantity(Math.round(Number(value || 0) * 100) / 100);
}

function formatDateTime(value) {
  if (!value) return '';

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('he-IL', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Jerusalem',
  }).format(date);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeFileName(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'order';
}

function buildOrderPdfFilename(order) {
  return 'order-' + safeFileName(order.orderId) + '.pdf';
}

function buildDocumentContactText(settings) {
  const parts = [];

  if (settings && settings.contactPhone) parts.push(settings.contactPhone);
  if (settings && settings.contactEmail) parts.push(settings.contactEmail);

  return parts.join(' | ');
}

function buildDocumentHeaderHtml(settings, documentTitle, metaParts) {
  const logoUrl = String(settings && settings.logoUrl || '').trim();
  const contactText = buildDocumentContactText(settings);
  const metaText = (metaParts || []).filter(part => String(part || '').trim()).join(' | ');
  const logoHtml = logoUrl
    ? '<img class="doc-logo" src="' + escapeHtml(logoUrl) + '" alt="פרינוק" onerror="this.style.display=\'none\'">'
    : '';

  return [
    '<header class="doc-header">',
    logoHtml,
    '<div class="doc-copy">',
    '<h1>', escapeHtml(documentTitle), '</h1>',
    metaText ? '<div class="doc-meta">' + escapeHtml(metaText) + '</div>' : '',
    contactText ? '<div class="doc-contact">' + escapeHtml(contactText) + '</div>' : '',
    '</div>',
    '</header>',
  ].join('');
}

function buildOrderPdfHtml(settings, order, items) {
  const safeItems = Array.isArray(items) ? items : [];
  const rows = safeItems.map(line => {
    const total = typeof line.lineTotal === 'number' ? formatMoney(line.lineTotal) : 'לפי חישוב בפועל';
    const noteHtml = line.note
      ? '<div class="item-note">הערה: ' + escapeHtml(line.note) + '</div>'
      : '';

    return [
      '<tr>',
      '<td>', escapeHtml(line.product.name), noteHtml, '</td>',
      '<td>', escapeHtml(line.product.department), '</td>',
      '<td>', escapeHtml(formatQuantity(line.quantity)), '</td>',
      '<td>', escapeHtml(line.orderUnit), '</td>',
      '<td>', escapeHtml(formatMoney(line.product.price) + ' / ' + (line.product.priceUnit || '')), '</td>',
      '<td>', escapeHtml(total), '</td>',
      '</tr>',
    ].join('');
  }).join('');

  return [
    '<!doctype html>',
    '<html dir="rtl" lang="he">',
    '<head>',
    '<meta charset="UTF-8">',
    '<style>',
    '@page{size:A4;margin:16mm 12mm;}',
    '*{box-sizing:border-box;}',
    'body{font-family:Arial,Helvetica,sans-serif;color:#1e2528;margin:0;line-height:1.45;background:#fff;}',
    '.doc-header{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:16px;border-bottom:2px solid #1f7a5a;padding-bottom:12px;}',
    '.doc-logo{width:76px;height:76px;object-fit:contain;flex:0 0 auto;}',
    '.doc-copy{text-align:center;}',
    '.doc-copy h1{margin:0 0 5px;font-size:26px;line-height:1.15;}',
    '.doc-meta{color:#667074;font-size:13px;font-weight:bold;}',
    '.doc-contact{margin-top:4px;color:#165a43;font-size:12px;font-weight:bold;}',
    '.box{border:1px solid #d9ded6;border-radius:8px;padding:14px;margin-bottom:16px;background:#f7f6f1;break-inside:avoid;}',
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;}',
    '.label{font-weight:bold;color:#165a43;}',
    'table{width:100%;border-collapse:collapse;margin-top:14px;}',
    'thead{display:table-header-group;}',
    'th{background:#1f7a5a;color:#fff;}',
    'th,td{border:1px solid #d9ded6;padding:8px;text-align:right;vertical-align:top;}',
    'tr{break-inside:avoid;page-break-inside:avoid;}',
    'tr:nth-child(even) td{background:#fbfcfa;}',
    '.notes{white-space:pre-wrap;}',
    '.total{font-size:18px;font-weight:bold;color:#165a43;}',
    '.notice{border:1px solid #d7e5db;background:#e5f2ec;color:#165a43;border-radius:8px;padding:10px 12px;margin-bottom:16px;font-weight:bold;}',
    '.item-note{font-size:11px;color:#667074;margin-top:3px;}',
    '</style>',
    '</head>',
    '<body>',
    buildDocumentHeaderHtml(settings, 'פרינוק - פרטי הזמנה', [
      order.orderId,
      settings && settings.saleName ? 'מכירה: ' + settings.saleName : '',
    ]),
    '<div class="box grid">',
    '<div><span class="label">לקוח:</span> ', escapeHtml(order.fullName), '</div>',
    '<div><span class="label">טלפון:</span> ', escapeHtml(order.phone), '</div>',
    order.email ? '<div><span class="label">מייל:</span> ' + escapeHtml(order.email) + '</div>' : '',
    '<div><span class="label">שיטת הזמנה:</span> ', escapeHtml(order.fulfillment), '</div>',
    '<div><span class="label">כתובת/איסוף:</span> ', escapeHtml(buildAddressText({ ...order, settings })), '</div>',
    '<div><span class="label">סכום משוער:</span> <span class="total">', escapeHtml(formatEstimatedTotal(order.estimatedTotal, order.unpricedItemCount)), '</span></div>',
    '<div><span class="label">זמן הזמנה:</span> ', escapeHtml(formatDateTime(order.timestamp)), '</div>',
    '</div>',
    '<div class="notice">', escapeHtml(getBillingNotice()), '</div>',
    order.notes ? '<div class="box notes"><span class="label">הערות:</span><br>' + escapeHtml(order.notes) + '</div>' : '',
    '<table>',
    '<thead><tr><th>מוצר</th><th>מחלקה</th><th>כמות</th><th>יחידה</th><th>מחיר</th><th>סכום</th></tr></thead>',
    '<tbody>', rows, '</tbody>',
    '</table>',
    '</body>',
    '</html>',
  ].join('');
}

async function resolveLaunchOptions() {
  const explicitPath = process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '';
  const localPath = !process.env.VERCEL ? explicitPath || getLocalChromiumPath() : '';

  if (localPath) {
    return {
      executablePath: localPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      defaultViewport: { width: 1280, height: 1600 },
      headless: true,
    };
  }

  return {
    executablePath: explicitPath || await chromium.executablePath(),
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    headless: chromium.headless,
  };
}

function getLocalChromiumPath() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

async function createOrderPdf(settings, order, items) {
  const html = buildOrderPdfHtml(settings, order, items);
  const launchOptions = await resolveLaunchOptions();
  let browser;

  browser = await puppeteer.launch({
    ...launchOptions,
    timeout: 15000,
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise(resolve => setTimeout(resolve, 400));
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '16mm',
        right: '12mm',
        bottom: '16mm',
        left: '12mm',
      },
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  buildAddressText,
  buildOrderPdfFilename,
  buildOrderPdfHtml,
  createOrderPdf,
  escapeHtml,
  formatEstimatedTotal,
  formatMoney,
  formatQuantity,
  getBillingNotice,
};
