if (process.env.VERCEL && !process.env.AWS_LAMBDA_JS_RUNTIME) {
  process.env.AWS_LAMBDA_JS_RUNTIME = 'nodejs22.x';
}

const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const TEMPLATE_WIDTH = 1280;
const TEMPLATE_HEIGHT = 2048;

const PRICE_FIELDS = [
  { name: 'תפוח אדמה לבן', x: 875, y: 500 },
  { name: 'תפוח אדמה לתנור', x: 875, y: 560 },
  { name: 'בצל לבן', x: 875, y: 624 },
  { name: 'בצל סגול', x: 875, y: 690 },
  { name: 'מלפפון', x: 875, y: 758 },
  { name: 'עגבניה', x: 875, y: 823 },
  { name: 'עגבניות שרי - לובלו', x: 875, y: 889 },
  { name: 'עגבניות שרי צהוב', x: 875, y: 955 },
  { name: 'פלפל אדום', x: 875, y: 1021 },
  { name: 'פלפל צהוב', x: 875, y: 1086 },
  { name: 'פלפל חריף', x: 875, y: 1151 },
  { name: 'קישוא', x: 875, y: 1217 },
  { name: 'גזר', x: 875, y: 1283 },
  { name: 'קולורבי', x: 875, y: 1348 },
  { name: 'זוקיני', x: 875, y: 1413 },
  { name: 'שומר', x: 875, y: 1479 },
  { name: 'חציל', x: 875, y: 1545 },
  { name: 'בטטה', x: 875, y: 1610 },
  { name: 'סלק', x: 875, y: 1676 },
  { name: 'לימון', x: 875, y: 1741 },
  { name: 'אבוקדו', x: 875, y: 1806 },
  { name: 'שום טרי', x: 875, y: 1872 },
  { name: 'שום יבש ענק', x: 875, y: 1936 },

  { name: 'תפוח גרנד', x: 415, y: 500 },
  { name: 'תפוח פינק ליידי', x: 415, y: 575 },
  { name: 'תפוח סמיט', x: 415, y: 651 },
  { name: 'אגס', x: 415, y: 727 },
  { name: 'שסק', x: 415, y: 802 },
  { name: 'אפרסק', x: 415, y: 877 },
  { name: 'נקטרינה', x: 415, y: 952 },
  { name: 'קיווי - חו"ל מיוחד', x: 415, y: 1027 },
  { name: 'אננס - חו"ל מיוחד', x: 415, y: 1102 },
  { name: 'ענבים ירוק - חו"ל', x: 415, y: 1177 },
  { name: 'ענבים לבן טלי', x: 415, y: 1252 },
  { name: 'ענב אדום טלי', x: 415, y: 1327 },
  { name: 'תפוז', x: 415, y: 1402 },
  { name: 'בננה', x: 415, y: 1478 },
  { name: 'תות שדה', x: 415, y: 1553 },
  { name: 'אבטיח', x: 415, y: 1628 },
  { name: 'מלון', x: 415, y: 1702 },

  { name: 'פטריות', x: 55, y: 500 },
  { name: 'נבטים חמניה', x: 55, y: 624 },
  { name: 'כרוב אדום', x: 55, y: 746 },
  { name: 'כרוב לבן', x: 55, y: 870 },
  { name: 'חסה', x: 55, y: 994 },
  { name: 'בצל ירוק', x: 55, y: 1118 },
  { name: 'סלרי', x: 55, y: 1242 },
  { name: 'כוסברה', x: 55, y: 1366 },
  { name: 'פטרוזיליה', x: 55, y: 1490 },
  { name: 'נענע', x: 55, y: 1614 },
  { name: 'בזיליקום', x: 55, y: 1738 },
];

const PRODUCT_ALIASES = {
  'תפוח אדמה לבן': ['תפו"א לבן', 'תפוח אדמה', 'תפוח אדמה לבן'],
  'תפוח אדמה לתנור': ['תפו"א לתנור', 'תפוח אדמה לתנור'],
  'עגבניות שרי - לובלו': ['עגבניות שרי לובלו', 'שרי לובלו'],
  'עגבניות שרי צהוב': ['שרי צהוב', 'עגבניות צהובות'],
  'קיווי - חו"ל מיוחד': ['קיווי', 'קיווי חול מיוחד', 'קיווי חו"ל'],
  'אננס - חו"ל מיוחד': ['אננס', 'אננס חול מיוחד', 'אננס חו"ל'],
  'ענבים ירוק - חו"ל': ['ענבים ירוק', 'ענבים ירוקים', 'ענבים ירוק חו"ל'],
  'ענבים לבן טלי': ['ענבים לבנים טלי', 'ענבים לבנים', 'ענבים לבן'],
  'ענב אדום טלי': ['ענבים אדום טלי', 'ענבים אדומים טלי', 'ענבים אדומים'],
};

function normalizeProductName(value) {
  return String(value || '')
    .trim()
    .replace(/[״"]/g, '"')
    .replace(/[׳']/g, "'")
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildProductLookup(products) {
  const lookup = new Map();

  (products || []).forEach(product => {
    lookup.set(normalizeProductName(product.name), product);
  });

  return lookup;
}

function findProduct(lookup, name) {
  const candidates = [name].concat(PRODUCT_ALIASES[name] || []);

  for (const candidate of candidates) {
    const exact = lookup.get(normalizeProductName(candidate));
    if (exact) return exact;
  }

  const normalizedCandidates = candidates.map(normalizeProductName);
  for (const [key, product] of lookup.entries()) {
    if (normalizedCandidates.some(candidate => key.includes(candidate) || candidate.includes(key))) {
      return product;
    }
  }

  return null;
}

function formatPrice(product) {
  if (!product) return '';
  return String(product.priceDisplay || formatQuantity(product.price || 0));
}

function formatQuantity(value) {
  const number = Number(value || 0);
  if (Math.abs(number - Math.round(number)) < 0.000001) return String(Math.round(number));
  return String(number).replace(/0+$/, '').replace(/\.$/, '');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getTemplateDataUrl() {
  const imagePath = path.join(__dirname, '..', 'assets', 'price-list-template.png');
  const buffer = fs.readFileSync(imagePath);
  return 'data:image/png;base64,' + buffer.toString('base64');
}

function buildPriceListHtml(catalog) {
  const products = catalog && catalog.products || [];
  const lookup = buildProductLookup(products);
  const templateDataUrl = getTemplateDataUrl();
  const prices = PRICE_FIELDS.map(field => {
    const product = findProduct(lookup, field.name);
    const value = formatPrice(product);

    return [
      '<div class="price" style="left:', field.x, 'px;top:', field.y, 'px">',
      escapeHtml(value),
      '</div>',
    ].join('');
  }).join('');

  return [
    '<!doctype html>',
    '<html lang="he" dir="rtl">',
    '<head>',
    '<meta charset="UTF-8">',
    '<style>',
    '@page{size:', TEMPLATE_WIDTH, 'px ', TEMPLATE_HEIGHT, 'px;margin:0;}',
    'html,body{margin:0;width:', TEMPLATE_WIDTH, 'px;height:', TEMPLATE_HEIGHT, 'px;background:#fff;}',
    '.sheet{position:relative;width:', TEMPLATE_WIDTH, 'px;height:', TEMPLATE_HEIGHT, 'px;overflow:hidden;}',
    '.bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}',
    '.price{position:absolute;width:96px;height:38px;display:flex;align-items:center;justify-content:center;font:700 25px Arial,Helvetica,sans-serif;color:#1b1f20;direction:ltr;unicode-bidi:bidi-override;}',
    '</style>',
    '</head>',
    '<body><div class="sheet">',
    '<img class="bg" src="', templateDataUrl, '" alt="">',
    prices,
    '</div></body>',
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
      defaultViewport: { width: TEMPLATE_WIDTH, height: TEMPLATE_HEIGHT },
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

async function createPriceListPdf(catalog) {
  const html = buildPriceListHtml(catalog);
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
      width: TEMPLATE_WIDTH + 'px',
      height: TEMPLATE_HEIGHT + 'px',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = {
  buildPriceListHtml,
  createPriceListPdf,
};
