const { readCatalog } = require('../lib/sheets');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const catalog = await readCatalog();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.json(catalog);
  } catch (error) {
    console.error('Catalog error:', error);
    res.status(500).json({ error: 'שגיאה בטעינת הקטלוג.' });
  }
};
