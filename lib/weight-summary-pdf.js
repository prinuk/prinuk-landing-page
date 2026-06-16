// "סיכום משקל ויחידות לקנייה" — the aggregated buying list (units + estimated kg
// per product, grouped by department), as a printable PDF for the market run.
const { renderHtmlToPdf } = require('./pdf-render');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Trim trailing zeros: 1.500 → "1.5", 4 → "4".
function fmtNum(n) {
  if (n == null || n === '' || isNaN(Number(n))) return '—';
  const v = Math.round(Number(n) * 1000) / 1000;
  return String(v);
}

const BASE_CSS = [
  "@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700;800&display=block');",
  '@page{size:A4;margin:12mm 10mm;}',
  "body{font-family:'Heebo','Arial Hebrew',Arial,sans-serif;color:#1e2528;margin:0;line-height:1.35;}",
  'h1{font-size:18px;margin:0 0 2px;}',
  '.sub{font-size:12px;color:#777;margin:0 0 12px;}',
  'table{width:100%;border-collapse:collapse;}',
  'th,td{border-bottom:1px solid #eee;padding:5px 7px;text-align:right;font-size:13px;}',
  'th{color:#667;font-size:11px;}',
  '.num{text-align:center;white-space:nowrap;}',
  '.dept td{background:#f4f7f1;font-weight:800;font-size:12.5px;color:#2c5338;}',
  '.flag{color:#b06a00;font-size:11px;font-weight:700;}',
].join('');

function buildWeightSummaryHtml(data, settings) {
  const items = (data && data.items) || [];
  const saleName = (data && data.saleName) || (settings && settings.saleName) || '';
  const title = 'סיכום משקל ויחידות לקנייה' + (saleName ? ' — ' + saleName : '');

  let rows = '';
  let lastDept = null;
  items.forEach((it) => {
    if (it.department !== lastDept) {
      rows += '<tr class="dept"><td colspan="3">' + escapeHtml(it.department || 'אחר') + '</td></tr>';
      lastDept = it.department;
    }
    const kg = it.estWeightKg != null ? fmtNum(it.estWeightKg) : '—';
    const flag = it.needsManualWeight ? ' <span class="flag">(לשקול ידנית)</span>' : '';
    rows += '<tr><td>' + escapeHtml(it.name) + flag + '</td>' +
      '<td class="num">' + fmtNum(it.totalUnits) + '</td>' +
      '<td class="num">' + kg + '</td></tr>';
  });

  return [
    '<!doctype html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><style>',
    BASE_CSS,
    '</style></head><body>',
    '<h1>', escapeHtml(title), '</h1>',
    '<p class="sub">', (data && data.orderCount) || 0, ' הזמנות</p>',
    '<table><thead><tr><th>מוצר</th><th class="num">יחידות</th><th class="num">ק״ג משוער</th></tr></thead><tbody>',
    rows,
    '</tbody></table>',
    '</body></html>',
  ].join('');
}

async function createWeightSummaryPdf(data, settings) {
  return renderHtmlToPdf(buildWeightSummaryHtml(data, settings));
}

module.exports = { buildWeightSummaryHtml, createWeightSummaryPdf };
