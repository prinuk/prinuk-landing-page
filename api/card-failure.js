const { logClientCardFailure } = require('../lib/store');

// Lightweight beacon: the customer's browser reports a card failure that never
// reached a charge (Cardcom tokenize decline / a client-side validation block),
// so we have a queryable record of WHY checkout card entry failed. Unauthenticated
// (it's a customer beacon) and best-effort — it must never affect the order flow.
// NEVER send card data here; only the failure reason + basic context.
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // sendBeacon posts a Blob → body may arrive unparsed; accept both.
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    // Surfaces in the Vercel function logs too (immediate visibility).
    console.error('[card-failure]', JSON.stringify({
      stage: body.stage, reason: body.reason, provider: body.provider,
      name: body.name, phone: body.phone,
    }));

    await logClientCardFailure({
      stage: body.stage,
      reason: body.reason,
      provider: body.provider,
      name: body.name,
      phone: body.phone,
      userAgent: body.ua || (req.headers && req.headers['user-agent']),
    });
  } catch (error) {
    console.error('card-failure handler error:', error && error.message);
  }
  // Always 204 — the beacon result is irrelevant to the customer.
  return res.status(204).end();
};
