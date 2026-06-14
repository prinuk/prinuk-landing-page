// Designed price flyer + product signs PDFs (ported from the Apps Script
// createDesignedPriceFlyerPdf_ / createProductSignsPdf_), reading the Postgres
// catalog instead of the sheet.
const { renderHtmlToPdf } = require('./pdf-render');
const { getUnitType, normalizeDepartment } = require('./sheets');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    // The serverless Chromium font lacks the Hebrew gershayim/geresh glyphs, so
    // substitute the visually-identical ASCII quotes (ק״ג → ק"ג, צ׳ילי → צ'ילי).
    .replace(/״/g, '"')
    .replace(/׳/g, "'")
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(d) {
  try {
    return new Intl.DateTimeFormat('he-IL', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(d);
  } catch (e) {
    return d.toISOString();
  }
}

function flyerCategoryColor(name) {
  const n = normalizeDepartment(name);
  if (n === 'עלים') return '#97A994';
  if (n === 'פירות') return '#D97A53';
  return '#2A523e'; // ירקות + default
}

// --- Price flyer (designed, A4) ---

function buildFlyerItemHtml(product) {
  const priceUnit = product.priceUnit || product.unit || '';
  return [
    '<tr>',
    '<td class="item-copy">',
    '<span class="item-name">', escapeHtml(product.name), '</span>',
    priceUnit ? '<span class="item-unit">ל-' + escapeHtml(priceUnit) + '</span>' : '',
    '</td>',
    '<td class="leader-cell"><div class="leader"></div></td>',
    '<td class="price-cell"><div class="price-box"><span class="currency">₪</span><span class="amount">', escapeHtml(product.priceDisplay), '</span></div></td>',
    '</tr>',
  ].join('');
}

function buildFlyerCategoryHtml(category) {
  const color = flyerCategoryColor(category.name);
  const titleClass = normalizeDepartment(category.name) === 'עלים' ? 'category-title light' : 'category-title';
  const items = (category.products || []).map(buildFlyerItemHtml).join('');
  return [
    '<section class="category-box">',
    '<h2 class="', titleClass, '" style="background:', color, ';">', escapeHtml(category.name), '</h2>',
    '<div class="category-items"><table class="item-table"><tbody>', items, '</tbody></table></div>',
    '</section>',
  ].join('');
}

function buildFlyerHtml(catalog) {
  const settings = (catalog && catalog.settings) || {};
  const categories = (catalog && catalog.categories) || [];
  const productCount = (catalog && catalog.products ? catalog.products.length : 0);
  const saleName = settings.saleName || '';
  const generatedAt = formatDateTime(new Date());
  const pickupText = settings.pickupText || '';
  const contactPhone = String(settings.contactPhone || '').trim();
  const contactEmail = String(settings.contactEmail || '').trim();
  const logoUrl = String(settings.logoUrl || '').trim();
  const categorySections = categories.map(buildFlyerCategoryHtml).join('');

  return [
    '<!doctype html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><style>',
    '@page{size:A4;margin:9mm;}',
    'body{font-family:Arial,Helvetica,sans-serif;color:#1e2528;margin:0;line-height:1.3;background:#fffaf2;}',
    '.flyer{border:2px solid #2a523e;border-radius:18px;padding:13px 14px 12px;background:#fffaf2;box-sizing:border-box;}',
    '.flyer-header{display:table;width:100%;border-collapse:collapse;margin-bottom:9px;}',
    '.logo-cell{display:table-cell;width:92px;text-align:center;vertical-align:middle;}',
    '.logo{width:84px;height:84px;object-fit:contain;display:block;margin:0 auto;}',
    '.headline{display:table-cell;text-align:center;vertical-align:middle;padding:0 10px;}',
    '.bsad{font-size:14px;font-weight:bold;color:#8a6b3d;margin-bottom:2px;}',
    '.brand{font-size:48px;font-weight:900;line-height:.95;color:#8b1712;}',
    '.subtitle{display:inline-block;margin-top:5px;padding:4px 18px;border-radius:5px;background:#2a523e;color:#fff7df;font-size:21px;font-weight:900;}',
    '.sale-name{margin-top:7px;font-size:20px;font-weight:900;color:#1e2528;}',
    '.meta-strip{margin:8px 0 10px;padding:7px 10px;border-top:1px solid #e0d5b6;border-bottom:1px solid #e0d5b6;text-align:center;color:#8a1710;font-size:14px;font-weight:800;}',
    '.category-box{border:1px solid #d9cdaa;border-radius:12px;background:#fffdf8;margin:0 0 10px;break-inside:auto;}',
    '.category-title{margin:0;padding:8px 10px;text-align:center;color:#fff;font-size:21px;font-weight:900;break-after:avoid;}',
    '.category-title.light{color:#1e2528;}',
    '.category-items{padding:8px 9px 9px;}',
    '.item-table{width:100%;border-collapse:collapse;table-layout:fixed;}',
    '.item-table tr{break-inside:avoid;}',
    '.item-table td{border-bottom:1px dotted #d7c899;padding:3px 0;vertical-align:middle;}',
    '.item-table tr:last-child td{border-bottom:0;}',
    '.item-copy{width:54%;font-weight:900;color:#1e2528;}',
    '.item-name{display:block;font-size:13px;line-height:1.12;word-break:break-word;}',
    '.item-unit{display:block;font-size:9px;line-height:1.1;color:#8a6b3d;font-weight:800;margin-top:1px;}',
    '.leader-cell{padding:0 5px;}.leader{border-bottom:1px dotted #bda56f;height:1px;}',
    '.price-cell{width:52px;}',
    '.price-box{text-align:center;border:1px solid #2a523e;border-radius:7px;background:#fff;color:#2a523e;padding:2px 4px;line-height:1;}',
    '.currency{font-size:10px;font-weight:900;margin-inline-start:2px;}.amount{font-size:17px;font-weight:900;}',
    '.flyer-footer{margin-top:10px;border:1px solid #d9cdaa;border-radius:11px;background:#fff8e7;padding:9px 12px;text-align:center;font-weight:900;}',
    '.footer-title{font-size:15px;color:#8a1710;margin-bottom:5px;}',
    '.footer-contact{font-size:20px;color:#1e2528;}.footer-contact span{display:inline-block;margin:0 8px;}',
    '.footer-pickup{margin-top:6px;font-size:15px;color:#2a523e;}',
    '.footer-free{margin-top:5px;font-size:16px;color:#8a1710;}',
    '</style></head><body>',
    '<section class="flyer">',
    '<header class="flyer-header">',
    '<div class="logo-cell">', logoUrl ? '<img class="logo" src="' + escapeHtml(logoUrl) + '" alt="פרינוּק">' : '', '</div>',
    '<div class="headline">',
    '<div class="bsad">בס״ד</div>',
    '<div class="brand">פרינוּק</div>',
    '<div class="subtitle">המכירה השבועית</div>',
    saleName ? '<div class="sale-name">' + escapeHtml(saleName) + '</div>' : '',
    '</div>',
    '<div class="logo-cell"></div>',
    '</header>',
    '<div class="meta-strip">מחירון שבועי | ', productCount, ' מוצרים | נוצר בתאריך ', escapeHtml(generatedAt), '</div>',
    '<div class="category-list">', categorySections, '</div>',
    '<footer class="flyer-footer">',
    '<div class="footer-title">ליצירת קשר או הזמנה בדרכים נוספות</div>',
    '<div class="footer-contact">',
    contactPhone ? '<span>טלפון / וואטסאפ: ' + escapeHtml(contactPhone) + '</span>' : '',
    contactEmail ? '<span>מייל: ' + escapeHtml(contactEmail) + '</span>' : '',
    '</div>',
    pickupText ? '<div class="footer-pickup">' + escapeHtml(pickupText) + '</div>' : '',
    '<div class="footer-free">משלוח: 25 ש״ח. בהזמנה מעל 200 ש״ח המשלוח חינם.</div>',
    '</footer>',
    '</section>',
    '</body></html>',
  ].join('');
}

// --- Product signs (one sign per product, two per A4 page) ---

function buildSignCell(product) {
  const unitLabel = getUnitType(product.priceUnit) === 'kg' ? 'ק״ג' : 'יחידה';
  const priceLine = product.priceDisplay + ' ש״ח ' + unitLabel;
  return [
    '<div class="sign">',
    '<div class="name">', escapeHtml(product.name), '</div>',
    '<div class="price">', escapeHtml(priceLine), '</div>',
    '</div>',
  ].join('');
}

function buildSignsHtml(catalog) {
  const products = (catalog && catalog.products) || [];
  const pages = [];
  for (let i = 0; i < products.length; i += 2) {
    let cells = buildSignCell(products[i]);
    cells += products[i + 1] ? buildSignCell(products[i + 1]) : '<div class="sign empty"></div>';
    pages.push('<div class="page">' + cells + '</div>');
  }

  return [
    '<!doctype html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><style>',
    '@page{size:A4;margin:0;}',
    '*{box-sizing:border-box;margin:0;padding:0;}',
    'html,body{background:#ffffff;}',
    'body{font-family:Arial,Helvetica,sans-serif;color:#000000;}',
    '.page{width:210mm;height:297mm;background:#fff;padding:9mm;page-break-after:always;display:flex;flex-direction:column;gap:9mm;}',
    '.page:last-child{page-break-after:auto;}',
    '.sign{flex:1 1 50%;min-height:0;border:3px solid #000;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:12mm 14mm;}',
    '.sign.empty{border:0;}',
    '.sign .name{font-size:76px;font-weight:900;line-height:1.12;word-break:break-word;}',
    '.sign .price{font-size:76px;font-weight:900;line-height:1.12;margin-top:9mm;}',
    '</style></head><body>',
    pages.join(''),
    '</body></html>',
  ].join('');
}

async function createFlyerPdf(catalog) {
  return renderHtmlToPdf(buildFlyerHtml(catalog));
}

async function createSignsPdf(catalog) {
  return renderHtmlToPdf(buildSignsHtml(catalog));
}

module.exports = { buildFlyerHtml, buildSignsHtml, createFlyerPdf, createSignsPdf };
