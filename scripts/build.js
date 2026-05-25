const fs = require('fs');
const path = require('path');

const { parseProducts, validateAndBuildOrder } = require('../lib/sheets');

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
  ['תפו״א אדום מיוחד דוד משה שק (כ1.7 ק״ג)', 'ירקות', 'יחידות', 'ק״ג', '9'],
  ['תפוח אדמה בייבי גורמה', 'ירקות', 'יחידות', 'ק״ג', '12'],
  ['עגבניות שרי צהוב (סלסלה)', 'ירקות', 'יחידות', 'ק״ג', '20'],
  ['שסק', 'פירות', 'יחידות', 'ק״ג', '18'],
  ['תפוח פינק ליידי', 'פירות', 'יחידות', 'ק״ג', '12'],
  ['נבטים עבים', 'ירקות', 'יחידות', 'יחידות', '7'],
  ['סלק בוואקום', 'ירקות', 'יחידות', 'יחידות', '10'],
  ['חסה לאליק', 'ירקות', 'יחידות', 'יחידות', '8'],
  ['כרוב לבן', 'ירקות', 'יחידות', 'יחידות', '9'],
  ['שומר', 'ירקות', 'יחידות', 'ק״ג', '8'],
  ['זוקיני', 'ירקות', 'יחידות', 'ק״ג', '10'],
  ['פלפל חלפיניו', 'ירקות', 'יחידות', 'יחידות', '5'],
  ['רימון', 'פירות', 'יחידות', 'יחידות', '8'],
  ['עלי בייבי', 'ירקות', 'יחידות', 'יחידות', '10'],
  ['לוף', 'ירקות', 'יחידות', 'ק״ג', '10'],
  ['קלמנטינה', 'פירות', 'יחידות', 'ק״ג', '10'],
  ['בצלצלי שאלוט', 'ירקות', 'יחידות', 'יחידות', '10'],
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
  assert(byName['תפו״א אדום מיוחד דוד משה שק (כ1.7 ק״ג)'].imageUrl === '/assets/produce/potato-red-david-moshe.jpg', 'David Moshe red potato image match failed.');
  assert(byName['תפוח אדמה בייבי גורמה'].imageUrl === '/assets/produce/gourmet-baby-potatoes.jpg', 'Gourmet baby potato image match failed.');
  assert(byName['עגבניות שרי צהוב (סלסלה)'].imageUrl === '/assets/produce/cherry-tomatoes-yellow.jpg', 'Cherry tomato image match failed.');
  assert(byName['שסק'].imageUrl === '/assets/produce/loquat.jpg', 'Loquat image match failed.');
  assert(byName['תפוח פינק ליידי'].imageUrl === '/assets/produce/apple-pink-lady.jpg', 'Pink Lady image match failed.');
  assert(byName['נבטים עבים'].imageUrl === '/assets/produce/thick-sprouts.jpg', 'Thick sprouts image match failed.');
  assert(byName['סלק בוואקום'].imageUrl === '/assets/produce/vacuum-beet.jpg', 'Vacuum beet image match failed.');
  assert(byName['חסה לאליק'].imageUrl === '/assets/produce/lettuce-lalik.jpg', 'Lalik lettuce image match failed.');
  assert(byName['כרוב לבן'].imageUrl === '/assets/produce/white-cabbage.jpg', 'White cabbage image match failed.');
  assert(byName['שומר'].estimatedUnitWeightKg === 0.25, 'Missing fennel unit weight estimate.');
  assert(byName['שומר'].imageUrl === '/assets/produce/fennel.jpg', 'Fennel image match failed.');
  assert(byName['זוקיני'].estimatedUnitWeightKg === 0.1, 'Missing zucchini unit weight estimate.');
  assert(byName['זוקיני'].imageUrl === '/assets/produce/zucchini.jpg', 'Zucchini image match failed.');
  assert(byName['פלפל חלפיניו'].imageUrl === '/assets/produce/jalapeno-pepper.jpg', 'Jalapeno pepper image match failed.');
  assert(byName['רימון'].imageUrl === '/assets/produce/pomegranate.jpg', 'Pomegranate image match failed.');
  assert(byName['עלי בייבי'].imageUrl === '/assets/produce/baby-leaves.jpg', 'Baby leaves image match failed.');
  assert(byName['לוף'].estimatedUnitWeightKg === 0.4, 'Missing leek unit weight estimate.');
  assert(byName['לוף'].imageUrl === '/assets/produce/leek.jpg', 'Leek image match failed.');
  assert(byName['קלמנטינה'].estimatedUnitWeightKg === 0.22, 'Missing clementine unit weight estimate.');
  assert(byName['קלמנטינה'].imageUrl === '/assets/produce/clementine.jpg', 'Clementine image match failed.');
  assert(byName['בצלצלי שאלוט'].imageUrl === '/assets/produce/shallots.jpg', 'Shallots image match failed.');

  products.forEach(product => {
    if (product.imageUrl && product.imageUrl.startsWith('/assets/produce/')) {
      assertFileExists(product.imageUrl.slice(1));
    }
  });
}

function validatePhoneRules() {
  const products = parseProducts(SAMPLE_PRODUCTS);
  const basePayload = {
    customer: {
      fullName: 'ישראל ישראלי',
      phone: '+972-53-523-4975',
      email: '',
    },
    fulfillment: 'איסוף עצמי',
    delivery: {},
    items: [
      {
        id: products[0].id,
        quantity: 1,
        mode: 'unit',
      },
    ],
  };

  const order = validateAndBuildOrder(basePayload, products);
  assert(order.phone === '0535234975', 'Expected +972 mobile phone to normalize to local format.');

  try {
    validateAndBuildOrder({
      ...basePayload,
      customer: {
        ...basePayload.customer,
        phone: '02-123-4567',
      },
    }, products);
    throw new Error('Expected landline phone validation to fail.');
  } catch (error) {
    assert(String(error.message || error).includes('מספר הטלפון הנייד אינו תקין'), 'Unexpected invalid phone error.');
  }
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
  validatePhoneRules();
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
