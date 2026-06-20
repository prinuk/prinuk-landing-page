'use strict';
// Provider-agnostic payment adapter. Choose the provider with the PAYMENT_PROVIDER
// env var (default 'mock', so nothing real is charged until Sumit is configured
// AND its endpoints are verified — see lib/payments/sumit.js).
//
// MODEL: tokenize-then-charge-final (NOT a J5 hold). At checkout the customer's
// card is tokenized on the provider and stored against a customer (saveCard).
// After the order is weighed/picked, the team charges the EXACT final amount
// (charge), which also issues a tax invoice. This fits weight-variable billing
// with no authorize/buffer/over-capture dance.
//
// Card data NEVER touches our servers/DB/logs: the browser tokenizes via the
// provider's hosted fields and we only ever handle opaque tokens/refs.
//
// Adapter contract — every method is async, returns a plain object, and signals
// normal failures with { ok: false, error } instead of throwing (so callers can
// record the failure + alert without try/catch around business logic):
//
//   publicConfig()
//     -> { provider, companyId, apiPublicKey }   // client-safe values only
//   saveCard({ singleUseToken, customer })
//     -> { ok, customerRef, cardLast4, brand, error }
//   charge({ customerRef, amountAgorot, description, items, customer, idempotencyKey })
//     -> { ok, paymentRef, invoiceRef, invoiceUrl, error }
//   refund({ paymentRef, amountAgorot, idempotencyKey })
//     -> { ok, refundRef, error }

const PROVIDER = String(process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();

let cached = null;

function getPaymentAdapter() {
  if (cached) return cached;
  cached = PROVIDER === 'sumit' ? require('./sumit') : require('./mock');
  return cached;
}

// True only when a real provider is configured — gate the customer-facing credit
// option on this so we never show "credit" before it can actually charge.
function paymentsEnabled() {
  return PROVIDER === 'sumit';
}

module.exports = { getPaymentAdapter, paymentsEnabled, PROVIDER };
