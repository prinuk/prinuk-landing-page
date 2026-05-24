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
      title: 'פרינוק - בדיקת הזמנה',
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
      const unitButton = row.querySelector('[data-mode-button="unit"]');
      const input = row.querySelector('.quantity-input');
      const estimate = row.querySelector('[data-row-estimate]');

      const noteHiddenBefore = note.classList.contains('hidden');

      unitButton.click();
      input.value = '2';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      return {
        estimateText: estimate.textContent,
        noteHiddenBefore,
        noteHiddenAfter: note.classList.contains('hidden'),
        imageLoaded: image.complete && image.naturalWidth > 0,
        summaryTotal: document.getElementById('summaryTotal').textContent,
      };
    });

    if (!result.imageLoaded) {
      throw new Error('Product image did not load.');
    }

    if (!result.noteHiddenBefore || result.noteHiddenAfter) {
      throw new Error('Product note visibility did not follow selected quantity.');
    }

    if (!result.estimateText.includes('₪3')) {
      throw new Error('Expected row estimate to include ₪3, got: ' + result.estimateText);
    }

    if (!result.summaryTotal.includes('₪3')) {
      throw new Error('Expected summary total to include ₪3, got: ' + result.summaryTotal);
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
