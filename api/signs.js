const { getActiveCatalog } = require('../lib/store');
const { createSignsPdf } = require('../lib/flyer-pdf');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const catalog = await getActiveCatalog();
    if (!catalog.products.length) {
      return res.status(400).json({ error: 'אין מוצרים פעילים עם מחיר ליצירת שלטים.' });
    }
    const pdf = await createSignsPdf(catalog);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="prinuk-signs.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (error) {
    console.error('Signs PDF error:', error);
    res.status(500).json({ error: 'שגיאה ביצירת השלטים.' });
  }
};
