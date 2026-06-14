const { getActiveCatalog } = require('../lib/store');
const { createFlyerPdf } = require('../lib/flyer-pdf');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const catalog = await getActiveCatalog();
    const pdf = await createFlyerPdf(catalog);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="prinuk-flyer.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(pdf)); // page.pdf() returns a Uint8Array; send raw bytes
  } catch (error) {
    console.error('Flyer PDF error:', error);
    res.status(500).json({ error: 'שגיאה ביצירת הפלייר.' });
  }
};
