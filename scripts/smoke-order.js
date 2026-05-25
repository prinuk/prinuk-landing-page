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
      };
    });

    if (!result.imageLoaded) {
      throw new Error('Product image did not load.');
    }

    if (result.modeButtonCount !== 0) {
      throw new Error('Expected kg/unit mode buttons to be hidden.');
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

    if (result.summaryNames.join('|') !== 'עגבניה איכותית|שום קלוף') {
      throw new Error('Expected summary items in add order, got: ' + result.summaryNames.join('|'));
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
