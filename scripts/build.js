const fs = require('fs');
const path = require('path');

const { parseProducts } = require('../lib/sheets');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'public');
const REQUIRED_FILES = [
  'index.html',
  'order/index.html',
  'script.js',
  'styles.css',
  'api/catalog.js',
  'api/order.js',
  'lib/sheets.js',
  'assets/produce-photo-bg.png',
];
const STATIC_ENTRIES = [
  'index.html',
  'order',
  'script.js',
  'styles.css',
  'assets',
];

const SAMPLE_PRODUCTS = [
  ['שם', 'מחלקה', 'יחידה', 'יחידת מחיר', 'מחיר'],
  ['תפו״א לבן שק (כ4 ק״ג)', 'ירקות', 'יחידות', 'ק״ג', '8'],
  ['עגבניות שרי צהוב (סלסלה)', 'ירקות', 'יחידות', 'ק״ג', '20'],
  ['תפוח פינק ליידי', 'פירות', 'יחידות', 'ק״ג', '12'],
  ['שומר', 'ירקות', 'יחידות', 'ק״ג', '8'],
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertFileExists(relativePath) {
  assert(fs.existsSync(path.join(ROOT, relativePath)), 'Missing required file: ' + relativePath);
}

function findLocalReferences(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const refs = [];
  const pattern = /\b(?:src|href)=["']([^"']+)["']/g;
  let match;

  while ((match = pattern.exec(html))) {
    const ref = match[1];
    if (
      ref.startsWith('/') &&
      !ref.startsWith('/api/') &&
      !ref.startsWith('//')
    ) {
      refs.push(ref.slice(1));
    } else if (
      !ref.includes(':') &&
      !ref.startsWith('#') &&
      !ref.startsWith('/api/')
    ) {
      refs.push(path.normalize(path.join(path.dirname(file), ref)));
    }
  }

  return refs;
}

function validateStaticReferences() {
  ['index.html', 'order/index.html'].forEach(file => {
    findLocalReferences(file).forEach(ref => {
      assertFileExists(ref);
    });
  });
}

function validateProductImages() {
  const produceDir = path.join(ROOT, 'assets/produce');
  const images = fs.readdirSync(produceDir).filter(file => /\.(jpe?g|png|webp)$/i.test(file));

  assert(images.length >= 40, 'Expected product images in assets/produce.');

  images.forEach(file => {
    const size = fs.statSync(path.join(produceDir, file)).size;
    assert(size <= 120 * 1024, 'Product image is too large: ' + file);
  });

  const products = parseProducts(SAMPLE_PRODUCTS);
  const byName = Object.fromEntries(products.map(product => [product.name, product]));

  assert(byName['תפו״א לבן שק (כ4 ק״ג)'].estimatedUnitWeightKg === 4, 'Missing potato unit weight estimate.');
  assert(byName['עגבניות שרי צהוב (סלסלה)'].imageUrl === '/assets/produce/cherry-tomatoes-yellow.jpg', 'Cherry tomato image match failed.');
  assert(byName['תפוח פינק ליידי'].imageUrl === '/assets/produce/apple-pink-lady.jpg', 'Pink Lady image match failed.');
  assert(byName['שומר'].estimatedUnitWeightKg === 0.25, 'Missing fennel unit weight estimate.');

  products.forEach(product => {
    if (product.imageUrl.startsWith('/assets/produce/')) {
      assertFileExists(product.imageUrl.slice(1));
    }
  });
}

function copyStaticEntry(relativePath) {
  const from = path.join(ROOT, relativePath);
  const to = path.join(OUTPUT_DIR, relativePath);
  const stat = fs.statSync(from);

  fs.mkdirSync(path.dirname(to), { recursive: true });

  if (stat.isDirectory()) {
    fs.cpSync(from, to, {
      recursive: true,
      filter: source => path.basename(source) !== '.DS_Store',
    });
    return;
  }

  fs.copyFileSync(from, to);
}

function writeStaticOutput() {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  STATIC_ENTRIES.forEach(copyStaticEntry);
}

function main() {
  REQUIRED_FILES.forEach(assertFileExists);
  validateStaticReferences();
  validateProductImages();
  writeStaticOutput();
  console.log('Build validation OK');
  console.log('Static output written to public/');
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
