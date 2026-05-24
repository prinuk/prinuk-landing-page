const { createPriceListPdf } = require('../lib/price-list-pdf');
const { readCatalog } = require('../lib/sheets');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const catalog = await readCatalog();
    const pdf = await createPriceListPdf(catalog);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="prinuk-price-list.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (error) {
    console.error('Price list PDF error:', error);
    res.status(500).json({ error: 'שגיאה ביצירת המחירון.' });
  }
};
