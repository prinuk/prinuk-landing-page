'use strict';
// Mock payment adapter — no network, deterministic fakes. Lets the whole
// cash/credit flow (saveCard → charge → invoice) be built and tested end-to-end
// before real Sumit credentials exist. Selected when PAYMENT_PROVIDER !== 'sumit'.

let seq = 1000;

function publicConfig() {
  return { provider: 'mock', companyId: 'MOCK', apiPublicKey: 'MOCK_PUBLIC_KEY' };
}

async function saveCard({ singleUseToken } = {}) {
  if (!singleUseToken) return { ok: false, error: 'missing token' };
  seq += 1;
  return { ok: true, customerRef: 'mock_cust_' + seq, cardLast4: '4242', brand: 'visa' };
}

async function charge({ customerRef, amountAgorot } = {}) {
  if (!customerRef) return { ok: false, error: 'missing customerRef' };
  if (!amountAgorot || amountAgorot <= 0) return { ok: false, error: 'invalid amount' };
  seq += 1;
  const ref = 'mock_pay_' + seq;
  return {
    ok: true,
    paymentRef: ref,
    invoiceRef: 'mock_inv_' + seq,
    invoiceUrl: 'https://example.com/invoice/' + ref,
  };
}

async function refund({ paymentRef } = {}) {
  if (!paymentRef) return { ok: false, error: 'missing paymentRef' };
  seq += 1;
  return { ok: true, refundRef: 'mock_ref_' + seq };
}

module.exports = { publicConfig, saveCard, charge, refund };
