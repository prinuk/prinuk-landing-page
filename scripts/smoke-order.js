const fs = require('fs');
const http = require('http');
const path = require('path');

const puppeteer = require('puppeteer-core');
const { parseProducts } = require('../lib/sheets');

const ROOT = path.resolve(__dirname, '..');
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const CATALOG_ROWS = [
  ['שם', 'מחלקה', 'יחידה', 'יחידת מחיר', 'מחיר'],
  ['עגבניה איכותית', 'ירקות', 'ק״ג', 'ק״ג', '10'],
  ['תפוח פינק ליידי', 'פירות', 'ק״ג', 'ק״ג', '12'],
  ['שומר', 'ירקות', 'יחידות', 'ק״ג', '8'],
  ['שום קלוף', 'ירקות', 'יחידות', 'יחידות', '5'],
];

function findChromeExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  return candidates.find(candidate => fs.existsSync(candidate));
}

function buildCatalog() {
  const products = parseProducts(CATALOG_ROWS);
  const categoriesByName = {};

  products.forEach(product => {
    if (!categoriesByName[product.department]) {
      categoriesByName[product.department] = [];
    }

    categoriesByName[product.department].push(product);
  });

  return {
    settings: {
      title: 'פרינוּק - בדיקת הזמנה',
      pickupText: 'בדיקת איסוף',
      contactPhone: '0535234975',
      contactEmail: 'prinuk10@gmail.com',
    },
    products,
    categories: Object.keys(categoriesByName).map(name => ({
      name,
      products: categoriesByName[name],
    })),
  };
}

function createServer(catalog) {
  return http.createServer((req, res) => {
    if (req.url === '/api/catalog') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(catalog));
      return;
    }

    let requestPath = decodeURIComponent(String(req.url || '/').split('?')[0]);

    if (requestPath === '/') {
      requestPath = '/index.html';
    } else if (requestPath === '/order/') {
      requestPath = '/order/index.html';
    }

    const fullPath = path.normalize(path.join(ROOT, requestPath));

    if (!fullPath.startsWith(ROOT)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    fs.readFile(fullPath, (error, data) => {
      if (error) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      res.setHeader('content-type', MIME_TYPES[path.extname(fullPath).toLowerCase()] || 'application/octet-stream');
      res.end(data);
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

async function runSmokeTest(baseUrl, executablePath) {
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/order/', { waitUntil: 'networkidle0', timeout: 15000 });

    const noticeButton = await page.$('#marketNoticeAccept');
    if (noticeButton) {
      await noticeButton.click();
    }

    await page.waitForSelector('.product-row', { timeout: 10000 });

    const stickyHeaderResult = await page.evaluate(async () => {
      window.scrollTo(0, 600);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const header = document.querySelector('.store-header');
      const result = {
        scrollY: window.scrollY,
        top: header.getBoundingClientRect().top,
      };

      window.scrollTo(0, 0);
      return result;
    });

    if (stickyHeaderResult.scrollY < 100 || Math.abs(stickyHeaderResult.top) > 1) {
      throw new Error('Expected store header to remain sticky after scroll, got: ' + JSON.stringify(stickyHeaderResult));
    }

    const phoneValidationResult = await page.evaluate(() => {
      const phone = document.getElementById('phone');
      const phoneError = document.getElementById('phoneError');
      phone.value = '02-123-4567';
      phone.dispatchEvent(new Event('input', { bubbles: true }));
      phone.dispatchEvent(new Event('blur', { bubbles: true }));

      return {
        text: phoneError.textContent,
        shown: phoneError.classList.contains('show'),
        invalid: phone.getAttribute('aria-invalid'),
      };
    });

    if (!phoneValidationResult.shown || phoneValidationResult.invalid !== 'true' || !phoneValidationResult.text.includes('מספר הטלפון הנייד אינו תקין')) {
      throw new Error('Expected phone validation under field, got: ' + JSON.stringify(phoneValidationResult));
    }

    const result = await page.evaluate(() => {
      function findRow(namePart) {
        return [...document.querySelectorAll('.product-row')]
          .find(row => String(row.getAttribute('data-name') || '').includes(namePart));
      }

      const row = findRow('עגבניה');
      if (!row) throw new Error('Product row not found.');

      const image = row.querySelector('.product-image');
      const note = row.querySelector('.product-note');
      const input = row.querySelector('.quantity-input');
      const estimate = row.querySelector('[data-row-estimate]');
      const modeButtons = row.querySelectorAll('[data-mode-button]');

      const noteHiddenBefore = note.classList.contains('hidden');

      input.value = '1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const singleUnitEstimateText = estimate.textContent;

      input.value = '2';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      const unitPricedRow = findRow('שום');
      if (!unitPricedRow) throw new Error('Unit-priced product row not found.');

      const unitPricedInput = unitPricedRow.querySelector('.quantity-input');
      const unitPricedEstimate = unitPricedRow.querySelector('[data-row-estimate]');

      unitPricedInput.value = '3';
      unitPricedInput.dispatchEvent(new Event('input', { bubbles: true }));

      const summaryNames = [...document.querySelectorAll('.summary-line strong')].map(item => item.textContent);

      return {
        estimateText: estimate.textContent,
        singleUnitEstimateText,
        modeButtonCount: modeButtons.length,
        unitPricedEstimateText: unitPricedEstimate.textContent,
        noteHiddenBefore,
        noteHiddenAfter: note.classList.contains('hidden'),
        imageLoaded: image.complete && image.naturalWidth > 0,
        summaryNames,
        summaryTotal: document.getElementById('summaryTotal').textContent,
        freeDeliveryNow: document.getElementById('freeDeliveryTrack').getAttribute('aria-valuenow'),
        freeDeliveryText: document.getElementById('freeDeliveryMessage').textContent,
        headerCartCount: document.getElementById('headerCartCount').textContent,
        headerCartCountHidden: document.getElementById('headerCartCount').hidden,
      };
    });

    if (!result.imageLoaded) {
      throw new Error('Product image did not load.');
    }

    if (result.modeButtonCount !== 2) {
      throw new Error('Expected unit/kg mode buttons on a kg-sale-unit item, got: ' + result.modeButtonCount);
    }

    if (!result.noteHiddenBefore || result.noteHiddenAfter) {
      throw new Error('Product note visibility did not follow selected quantity.');
    }

    if (!result.estimateText.includes('₪3') || !result.estimateText.includes('כ-0.3 ק״ג')) {
      throw new Error('Expected row estimate to include ₪3, got: ' + result.estimateText);
    }

    if (!result.estimateText.includes('סכום משוער')) {
      throw new Error('Expected row estimate to use estimated total wording, got: ' + result.estimateText);
    }

    if (!result.singleUnitEstimateText.includes('סכום משוער') || !result.singleUnitEstimateText.includes('₪1.5') || !result.singleUnitEstimateText.includes('כ-0.15 ק״ג')) {
      throw new Error('Expected kg-priced row to use unit estimate wording, got: ' + result.singleUnitEstimateText);
    }

    if (!result.unitPricedEstimateText.includes('סכום: ₪15') || result.unitPricedEstimateText.includes('סכום משוער')) {
      throw new Error('Expected unit-priced row to use fixed total wording, got: ' + result.unitPricedEstimateText);
    }

    if (!result.summaryTotal.includes('₪18')) {
      throw new Error('Expected summary total to include ₪18, got: ' + result.summaryTotal);
    }

    if (result.freeDeliveryNow !== '9' || !result.freeDeliveryText.includes('₪182')) {
      throw new Error('Expected free-delivery progress for ₪18 subtotal, got: ' + JSON.stringify(result));
    }

    if (result.headerCartCount !== '2' || result.headerCartCountHidden) {
      throw new Error('Expected visible header cart badge for 2 selected items, got: ' + JSON.stringify(result));
    }

    if (result.summaryNames.join('|') !== 'עגבניה איכותית|שום קלוף') {
      throw new Error('Expected summary items in add order, got: ' + result.summaryNames.join('|'));
    }

    const cartDrawerResult = await page.evaluate(() => {
      document.getElementById('headerCartButton').click();
      const opened = document.getElementById('orderSummary').classList.contains('is-open')
        && document.getElementById('cartOverlay').classList.contains('show');
      document.getElementById('cartCloseButton').click();

      return {
        opened,
        closed: !document.getElementById('orderSummary').classList.contains('is-open')
          && !document.getElementById('cartOverlay').classList.contains('show'),
      };
    });

    if (!cartDrawerResult.opened || !cartDrawerResult.closed) {
      throw new Error('Expected header cart drawer to open and close, got: ' + JSON.stringify(cartDrawerResult));
    }

    // Switching a kg-sale-unit item to ק״ג gives an exact (non-estimated)
    // total and a 0.5 kg step.
    const kgResult = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.product-row')]
        .find(r => String(r.getAttribute('data-name') || '').includes('עגבניה'));
      row.querySelector('[data-mode-button="kg"]').click();

      const input = row.querySelector('.quantity-input');
      const convertedValue = input.value; // 2 units × 0.15 kg ≈ 0.3 → 0.5

      input.value = '1.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      return {
        mode: row.getAttribute('data-mode'),
        step: input.step,
        suffix: row.querySelector('.suffix').textContent,
        convertedValue,
        estimateText: row.querySelector('[data-row-estimate]').textContent,
      };
    });

    if (kgResult.mode !== 'kg' || kgResult.step !== '0.5' || kgResult.suffix !== 'ק״ג') {
      throw new Error('Expected kg mode with 0.5 step and ק״ג suffix, got: ' + JSON.stringify(kgResult));
    }

    if (kgResult.convertedValue !== '0.5') {
      throw new Error('Expected 2 units to convert to 0.5 kg on switch, got: ' + kgResult.convertedValue);
    }

    if (!kgResult.estimateText.includes('סכום: ₪15') || kgResult.estimateText.includes('משוער')) {
      throw new Error('Expected exact kg total ₪15 (1.5×10), got: ' + kgResult.estimateText);
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.reload({ waitUntil: 'networkidle0', timeout: 15000 });
    await page.waitForSelector('.product-row', { timeout: 10000 });
    await page.waitForFunction(() => window.pageYOffset > 100, { timeout: 5000 });

    page.on('dialog', dialog => dialog.accept());
    await page.click('#resetOrderButton');

    const resetResult = await page.evaluate(() => ({
      summaryCount: document.getElementById('summaryCount').textContent,
      filledQuantities: [...document.querySelectorAll('.quantity-input')]
        .filter(input => String(input.value || '').trim()).length,
      draft: window.localStorage.getItem('prinukOrderDraft:v1'),
    }));

    if (resetResult.summaryCount !== '0 מוצרים' || resetResult.filledQuantities !== 0 || resetResult.draft) {
      throw new Error('Expected reset button to clear order, got: ' + JSON.stringify(resetResult));
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const executablePath = findChromeExecutable();

  if (!executablePath) {
    throw new Error('Chrome executable not found. Install Google Chrome or set PUPPETEER_EXECUTABLE_PATH=/path/to/chrome.');
  }

  const server = createServer(buildCatalog());
  const port = await listen(server);

  try {
    await runSmokeTest('http://127.0.0.1:' + port, executablePath);
    console.log('Order browser smoke test OK');
  } finally {
    await closeServer(server);
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
