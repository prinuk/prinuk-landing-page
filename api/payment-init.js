const { paymentsEnabled, getPaymentAdapter, PROVIDER } = require('../lib/payments');

// Start a card-entry session for OPEN FIELDS (Cardcom). The browser needs a
// LowProfileId to run the hosted card iframes against; we create it server-side
// (Operation=CreateTokenOnly → tokenize the card WITHOUT charging; the final
// amount is billed later at picking). No card data passes through here.
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!paymentsEnabled()) {
    return res.status(400).json({ error: 'תשלום באשראי אינו זמין כרגע.' });
  }
  const adapter = getPaymentAdapter();
  if (typeof adapter.createLowProfile !== 'function') {
    // Providers without a hosted-page step (mock/sumit) don't use this endpoint.
    return res.status(400).json({ error: 'אמצעי הסליקה אינו דורש שלב אתחול.' });
  }

  try {
    const body = req.body || {};
    const amountAgorot = Number(body.amountAgorot || 0) || 0;
    const orderRef = String(body.orderRef || '').slice(0, 60);

    const r = await adapter.createLowProfile({
      operation: 'CreateTokenOnly',
      amountAgorot,
      description: 'הזמנה - פרינוק',
      returnValue: orderRef,
    });
    if (!r.ok) {
      console.error('payment-init createLowProfile failed:', r.error, PROVIDER);
      return res.status(502).json({ error: 'לא הצלחנו לפתוח את טופס התשלום. נסו שוב בעוד רגע.' });
    }
    return res.json({ lowProfileId: r.lowProfileId });
  } catch (error) {
    console.error('payment-init error:', error);
    return res.status(500).json({ error: 'שגיאה בפתיחת טופס התשלום.' });
  }
};
