// Batch order PDFs for the team: full orders and headers-only (contact + notes).
const { renderHtmlToPdf } = require('./pdf-render');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(n) {
  if (n === '' || n == null || isNaN(Number(n))) return '';
  const v = Math.round(Number(n) * 100) / 100;
  return '₪' + (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(v));
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
  } catch (e) {
    return d.toISOString();
  }
}

function addressOf(o) {
  if (o.fulfillment === 'משלוח') {
    return [o.address, o.floor ? 'קומה ' + o.floor : '', o.apartment ? 'דירה ' + o.apartment : ''].filter(Boolean).join(', ');
  }
  return 'איסוף עצמי';
}

const BASE_CSS = [
  "@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700;800&display=block');",
  '@page{size:A4;margin:12mm 10mm;}',
  "body{font-family:'Heebo','Arial Hebrew',Arial,sans-serif;color:#1e2528;margin:0;line-height:1.35;}",
  'h1{font-size:18px;margin:0 0 10px;}',
].join('');

// --- Full orders ---

function buildOrdersFullHtml(orders, settings, opts) {
  opts = opts || {};
  const title = opts.title || ((settings && settings.saleName) ? 'הזמנות — ' + settings.saleName : 'הזמנות');
  const blocks = orders.map((o) => {
    const rows = (o.items || []).map((it) => {
      const missing = it.pickStatus === 'חסר';
      const actualCell = it.isWeightPriced
        ? (it.actualWeightKg != null ? escapeHtml(it.actualWeightKg) + ' ק"ג' : '—')
        : (it.actualQuantity != null ? escapeHtml(it.actualQuantity) : '—');
      const lineFinal = (it.actualLineTotal !== '' && it.actualLineTotal != null) ? it.actualLineTotal : it.lineTotal;
      return '<tr' + (missing ? ' class="miss"' : '') + '><td>' + escapeHtml(it.name) +
        (missing ? ' <span class="misstag">(חסר)</span>' : '') +
        (it.note ? '<div class="inote">📝 ' + escapeHtml(it.note) + '</div>' : '') + '</td>' +
        '<td class="c">' + escapeHtml(it.quantity) + ' ' + escapeHtml(it.orderUnit || '') + '</td>' +
        '<td class="c">' + (missing ? '—' : actualCell) + '</td>' +
        '<td class="c">' + (missing ? '—' : (lineFinal === '' || lineFinal == null ? '—' : money(lineFinal))) + '</td></tr>';
    }).join('');
    const hasActual = o.actualTotal !== '' && o.actualTotal != null && o.actualTotal > 0;
    const missingNames = (o.items || []).filter((it) => it.pickStatus === 'חסר').map((it) => it.name);
    const missingNote = missingNames.length
      ? '<div class="missing-note">⚠️ פריטים חסרים: ' + missingNames.map(escapeHtml).join(', ') + '</div>'
      : '';
    return [
      '<section class="order">',
      '<div class="ohead"><span class="oname">', escapeHtml(o.fullName || 'ללא שם'), '</span>',
      '<span class="ocode">', escapeHtml(o.orderId), ' · ', escapeHtml(fmtDate(o.timestamp)), '</span></div>',
      '<div class="oinfo">',
      '<span>📞 ', escapeHtml(o.phone || ''), '</span>',
      '<span>', o.fulfillment === 'משלוח' ? '🚚 ' : '🛍️ ', escapeHtml(addressOf(o)), '</span>',
      hasActual
        ? ('<span class="final">סה״כ סופי' + (opts.hideEstimate ? '' : ' (שקילה)') + ': ' + money(o.actualTotal) + '</span>'
            + (opts.hideEstimate ? '' : '<span>משוער: ' + escapeHtml(o.totalText || money(o.grandTotal)) + '</span>'))
        : '<span>' + (opts.hideEstimate ? 'סה״כ: ' : 'סה״כ משוער: ') + escapeHtml(o.totalText || money(o.grandTotal)) + '</span>',
      '</div>',
      o.notes ? '<div class="onotes">📝 ' + escapeHtml(o.notes) + '</div>' : '',
      missingNote,
      '<table><thead><tr><th>מוצר</th><th class="c">הוזמן</th><th class="c">בפועל</th><th class="c">סכום</th></tr></thead><tbody>', rows, '</tbody></table>',
      '</section>',
    ].join('');
  }).join('');

  return [
    '<!doctype html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><style>',
    BASE_CSS,
    '.order{border:1px solid #d9ded6;border-radius:8px;padding:10px 12px;margin:0 0 12px;break-inside:avoid;}',
    '.ohead{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid #eee;padding-bottom:5px;margin-bottom:6px;}',
    '.oname{font-size:16px;font-weight:800;}.ocode{font-size:11px;color:#777;}',
    '.oinfo{display:flex;flex-wrap:wrap;gap:12px;font-size:12.5px;font-weight:600;margin-bottom:6px;}',
    '.oinfo .final{color:#165a43;font-weight:800;}',
    '.onotes{font-size:12.5px;background:#fff8e7;border:1px solid #eadfc0;border-radius:6px;padding:5px 8px;margin-bottom:6px;}',
    'table{width:100%;border-collapse:collapse;}',
    'th,td{border-bottom:1px solid #eee;padding:4px 6px;text-align:right;font-size:12.5px;vertical-align:top;}',
    'th{color:#667;font-size:11px;}.c{text-align:center;white-space:nowrap;}',
    '.inote{font-size:11px;color:#8a6b3d;}',
    '.miss td{color:#999;text-decoration:line-through;}',
    '.miss .misstag{color:#d23030;text-decoration:none;font-weight:700;}',
    '.missing-note{font-size:12.5px;color:#8a1710;background:#fdecea;border:1px solid #f3cfca;border-radius:6px;padding:5px 8px;margin-bottom:6px;font-weight:700;}',
    '</style></head><body>',
    '<h1>', escapeHtml(title), (opts.title ? '' : ' (' + orders.length + ')'), '</h1>',
    blocks,
    '</body></html>',
  ].join('');
}

// --- Headers only (contact + notes), several per page ---

function buildOrdersHeadersHtml(orders, settings) {
  const title = (settings && settings.saleName) ? 'כותרות הזמנות — ' + settings.saleName : 'כותרות הזמנות';
  const cards = orders.map((o) => [
    '<div class="hcard">',
    '<div class="hname">', escapeHtml(o.fullName || 'ללא שם'), '<span class="hcount">', o.itemCount, ' פריטים</span></div>',
    '<div class="hline">📞 ', escapeHtml(o.phone || ''), '</div>',
    '<div class="hline">', o.fulfillment === 'משלוח' ? '🚚 ' : '🛍️ ', escapeHtml(addressOf(o)), '</div>',
    o.notes ? '<div class="hnotes">📝 ' + escapeHtml(o.notes) + '</div>' : '',
    '</div>',
  ].join('')).join('');

  return [
    '<!doctype html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><style>',
    BASE_CSS,
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}',
    '.hcard{border:1px solid #d9ded6;border-radius:8px;padding:8px 10px;break-inside:avoid;}',
    '.hname{font-weight:800;font-size:14px;display:flex;justify-content:space-between;align-items:baseline;}',
    '.hcount{font-size:11px;color:#777;font-weight:600;}',
    '.hline{font-size:12.5px;font-weight:600;margin-top:3px;}',
    '.hnotes{font-size:12px;background:#fff8e7;border:1px solid #eadfc0;border-radius:6px;padding:4px 7px;margin-top:5px;}',
    '</style></head><body>',
    '<h1>', escapeHtml(title), ' (', orders.length, ')</h1>',
    '<div class="grid">', cards, '</div>',
    '</body></html>',
  ].join('');
}

async function createOrdersFullPdf(orders, settings, opts) {
  return renderHtmlToPdf(buildOrdersFullHtml(orders, settings, opts));
}
async function createOrdersHeadersPdf(orders, settings) {
  return renderHtmlToPdf(buildOrdersHeadersHtml(orders, settings));
}

module.exports = { buildOrdersFullHtml, buildOrdersHeadersHtml, createOrdersFullPdf, createOrdersHeadersPdf };
