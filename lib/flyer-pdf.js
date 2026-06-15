// Designed price flyer + product signs PDFs, reading the Postgres catalog.
// A real Hebrew font (Heebo) is embedded so gershayim/geresh (״ ׳) render.
const { renderHtmlToPdf } = require('./pdf-render');
const { getUnitType, normalizeDepartment } = require('./sheets');

// Heebo includes full Hebrew incl. gershayim. display=block avoids a flash of
// fallback (we also await document.fonts.ready in the renderer).
const FONT_IMPORT = "@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700;800;900&display=block');";
const FONT_STACK = "'Heebo','Arial Hebrew',Arial,sans-serif";

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function flyerCategoryColor(name) {
  const n = normalizeDepartment(name);
  if (n === 'עלים') return '#97A994';
  if (n === 'פירות') return '#D97A53';
  return '#2A523e'; // ירקות + default
}

// --- shared header / footer (reused by the default + per-category variants) ---

function buildFlyerHeader(settings) {
  const saleName = settings.saleName || '';
  const logoUrl = String(settings.logoUrl || '').trim();
  return [
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
  ].join('');
}

function buildFlyerFooter(settings) {
  const pickupText = settings.pickupText || '';
  const contactPhone = String(settings.contactPhone || '').trim();
  const contactEmail = String(settings.contactEmail || '').trim();
  return [
    '<footer class="flyer-footer">',
    '<div class="footer-title">ליצירת קשר או הזמנה בדרכים נוספות</div>',
    '<div class="footer-contact">',
    contactPhone ? '<span>טלפון / וואטסאפ: ' + escapeHtml(contactPhone) + '</span>' : '',
    contactEmail ? '<span>מייל: ' + escapeHtml(contactEmail) + '</span>' : '',
    '</div>',
    pickupText ? '<div class="footer-pickup">' + escapeHtml(pickupText) + '</div>' : '',
    '<div class="footer-free">משלוח: 25 ש״ח. בהזמנה מעל 200 ש״ח המשלוח חינם.</div>',
    '</footer>',
  ].join('');
}

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

function buildFlyerCategoryHtml(category, breakBefore) {
  const color = flyerCategoryColor(category.name);
  const light = normalizeDepartment(category.name) === 'עלים';
  const cls = 'category-box' + (breakBefore ? ' cat-break' : '');
  const items = (category.products || []).map(buildFlyerItemHtml).join('');
  return [
    '<section class="', cls, '">',
    '<h2 class="category-title', light ? ' light' : '', '" style="background:', color, ';">', escapeHtml(category.name), '</h2>',
    '<div class="category-items"><table class="item-table"><tbody>', items, '</tbody></table></div>',
    '</section>',
  ].join('');
}

function flyerCss() {
  return [
    FONT_IMPORT,
    '@page{size:A4;margin:8mm;}',
    'body{font-family:', FONT_STACK, ';color:#1e2528;margin:0;line-height:1.28;background:#fffaf2;}',
    '.flyer-header{display:table;width:100%;border-collapse:collapse;margin-bottom:8px;}',
    '.logo-cell{display:table-cell;width:74px;text-align:center;vertical-align:middle;}',
    '.logo{width:66px;height:66px;object-fit:contain;display:block;margin:0 auto;}',
    '.headline{display:table-cell;text-align:center;vertical-align:middle;padding:0 8px;}',
    '.bsad{font-size:12px;font-weight:700;color:#8a6b3d;margin-bottom:1px;}',
    '.brand{font-size:40px;font-weight:900;line-height:.95;color:#8b1712;}',
    '.subtitle{display:inline-block;margin-top:4px;padding:3px 16px;border-radius:5px;background:#2a523e;color:#fff7df;font-size:18px;font-weight:900;}',
    '.sale-name{margin-top:5px;font-size:18px;font-weight:900;color:#1e2528;}',
    '.category-box{border:1px solid #d9cdaa;border-radius:12px;background:#fffdf8;margin:0 0 9px;break-inside:auto;}',
    '.cat-break{break-before:page;}',
    '.category-title{margin:0;padding:7px 10px;text-align:center;color:#fff;font-size:20px;font-weight:900;break-after:avoid;}',
    '.category-title.light{color:#1e2528;}',
    '.category-items{padding:7px 9px 8px;}',
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
    '.flyer-footer{margin-top:9px;border:1px solid #d9cdaa;border-radius:11px;background:#fff8e7;padding:7px 12px;text-align:center;font-weight:900;}',
    '.footer-title{font-size:13px;color:#8a1710;margin-bottom:4px;}',
    '.footer-contact{font-size:17px;color:#1e2528;}.footer-contact span{display:inline-block;margin:0 7px;}',
    '.footer-pickup{margin-top:5px;font-size:13px;color:#2a523e;}',
    '.footer-free{margin-top:4px;font-size:14px;color:#8a1710;}',
    // per-category variant: each category fills its own page with header+footer
    '.cat-page{display:flex;flex-direction:column;min-height:280mm;page-break-after:always;}',
    '.cat-page:last-child{page-break-after:auto;}',
    '.cat-page .category-box{flex:1 1 auto;}',
  ].join('');
}

// opts.perCategory: repeat header+footer on each category's own page (#5).
// otherwise (#4): single header; ירקות p1, פירות p2, עלים+מיוחדים after
// (page-break before פירות and עלים); single footer at the end.
function buildFlyerHtml(catalog, opts) {
  const settings = (catalog && catalog.settings) || {};
  const categories = (catalog && catalog.categories) || [];
  const perCategory = !!(opts && opts.perCategory);

  let bodyInner;
  if (perCategory) {
    bodyInner = categories.map((cat) => (
      '<div class="cat-page">' + buildFlyerHeader(settings) + buildFlyerCategoryHtml(cat, false) + buildFlyerFooter(settings) + '</div>'
    )).join('');
  } else {
    const cats = categories.map((cat) => {
      const dep = normalizeDepartment(cat.name);
      return buildFlyerCategoryHtml(cat, dep === 'פירות' || dep === 'עלים');
    }).join('');
    bodyInner = buildFlyerHeader(settings) + '<div class="category-list">' + cats + '</div>' + buildFlyerFooter(settings);
  }

  return [
    '<!doctype html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><style>',
    flyerCss(),
    '</style></head><body>',
    bodyInner,
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
    FONT_IMPORT,
    '@page{size:A4;margin:0;}',
    '*{box-sizing:border-box;margin:0;padding:0;}',
    'html,body{background:#ffffff;}',
    'body{font-family:', FONT_STACK, ';color:#000000;}',
    '.page{width:210mm;height:297mm;background:#fff;padding:9mm;page-break-after:always;display:flex;flex-direction:column;gap:9mm;}',
    '.page:last-child{page-break-after:auto;}',
    '.sign{flex:1 1 50%;min-height:0;border:3px solid #000;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:12mm 14mm;}',
    '.sign.empty{border:0;}',
    '.sign .name{font-size:72px;font-weight:900;line-height:1.12;word-break:break-word;}',
    '.sign .price{font-size:72px;font-weight:900;line-height:1.12;margin-top:9mm;}',
    '</style></head><body>',
    pages.join(''),
    '</body></html>',
  ].join('');
}

async function createFlyerPdf(catalog, opts) {
  return renderHtmlToPdf(buildFlyerHtml(catalog, opts));
}

async function createSignsPdf(catalog) {
  return renderHtmlToPdf(buildSignsHtml(catalog));
}

module.exports = { buildFlyerHtml, buildSignsHtml, createFlyerPdf, createSignsPdf };
