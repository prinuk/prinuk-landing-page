const { readCatalog } = require('../lib/store');
const { paymentsEnabled, getPaymentAdapter } = require('../lib/payments');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const catalog = await readCatalog();
    // Client-safe payment config (no secrets): drives the cash/credit checkout
    // choice + the hosted-fields tokenizer. Only the public key is exposed.
    catalog.payments = paymentsEnabled()
      ? Object.assign({ enabled: true }, getPaymentAdapter().publicConfig())
      : { enabled: false };
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.json(catalog);
  } catch (error) {
    console.error('Catalog error:', error);
    res.status(500).json({ error: 'שגיאה בטעינת הקטלוג.' });
  }
};
