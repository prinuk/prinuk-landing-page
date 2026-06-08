const crypto = require('crypto');
const {
  listOrdersForDashboard,
  readOrderForDashboard,
  claimOrderForPicking,
  updateOrderCollection,
} = require('../lib/sheets');

// Constant-time compare of the supplied key against DASHBOARD_PASSWORD.
function isAuthorized(req) {
  const expected = String(process.env.DASHBOARD_PASSWORD || '');
  if (!expected) return false; // fail closed if no password is configured

  const provided = String(
    (req.headers && (req.headers['x-dashboard-key'] || req.headers['X-Dashboard-Key'])) || '',
  );
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'הסיסמה שגויה.' });
  }

  try {
    if (req.method === 'GET') {
      const action = String((req.query && req.query.action) || 'list').trim();

      if (action === 'order') {
        const orderId = String((req.query && req.query.id) || '').trim();
        if (!orderId) return res.status(400).json({ error: 'חסר מספר הזמנה.' });
        const result = await readOrderForDashboard(orderId);
        if (!result.ok) return res.status(404).json({ error: 'ההזמנה לא נמצאה.' });
        return res.json({ ok: true, order: result.order });
      }

      const orders = await listOrdersForDashboard();
      return res.json({ ok: true, orders });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const action = String(body.action || '').trim();
      const orderId = String(body.orderId || '').trim();
      const member = String(body.member || '').trim();

      if (!orderId) return res.status(400).json({ error: 'חסר מספר הזמנה.' });

      if (action === 'claim') {
        const result = await claimOrderForPicking(orderId, member);
        if (!result.ok) return res.status(404).json({ error: 'ההזמנה לא נמצאה.' });
        return res.json(result);
      }

      if (action === 'collect') {
        const items = Array.isArray(body.items) ? body.items : [];
        const result = await updateOrderCollection(orderId, { member, items });
        if (!result.ok) return res.status(404).json({ error: 'ההזמנה לא נמצאה.' });
        return res.json(result);
      }

      return res.status(400).json({ error: 'פעולה לא תקינה.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Dashboard error:', error);
    return res.status(500).json({ error: 'שגיאה בטעינת הנתונים. נסו שוב בעוד רגע.' });
  }
};
