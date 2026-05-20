const { readCatalog, validateAndBuildOrder, writeOrder } = require('../lib/sheets');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const catalog = await readCatalog();
    const order = validateAndBuildOrder(req.body, catalog.products);
    await writeOrder(order);

    res.json({
      ok: true,
      orderId: order.orderId,
      itemCount: order.items.length,
      estimatedTotal: order.estimatedTotal,
      unpricedItemCount: order.unpricedItemCount,
      customerEmailStatus: 'לא נשלח',
    });
  } catch (error) {
    console.error('Order error:', error);
    const isValidation = error.message && !error.message.includes('sheets') && !error.message.includes('auth');
    res.status(isValidation ? 400 : 500).json({ error: error.message || 'שגיאה בשליחת ההזמנה.' });
  }
};
