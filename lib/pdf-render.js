// Shared HTML→PDF renderer (Chromium via puppeteer-core), used by the flyer and
// product-signs PDFs. The HTML controls the page size/margins via @page, so we
// render with preferCSSPageSize.
if (process.env.VERCEL && !process.env.AWS_LAMBDA_JS_RUNTIME) {
  process.env.AWS_LAMBDA_JS_RUNTIME = 'nodejs22.x';
}

const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

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
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

async function resolveLaunchOptions() {
  const explicitPath = process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '';
  const localPath = !process.env.VERCEL ? explicitPath || getLocalChromiumPath() : '';

  if (localPath) {
    return {
      executablePath: localPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      headless: true,
    };
  }

  return {
    executablePath: explicitPath || (await chromium.executablePath()),
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    headless: chromium.headless,
  };
}

async function renderHtmlToPdf(html) {
  const launchOptions = await resolveLaunchOptions();
  const browser = await puppeteer.launch({ ...launchOptions, timeout: 20000 });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return await page.pdf({ printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

module.exports = { renderHtmlToPdf, resolveLaunchOptions };
