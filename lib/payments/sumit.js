'use strict';
// Sumit (sumit.co.il / "OfficeGuy") payment adapter.
//
// Docs:
//   - REST API:        https://app.sumit.co.il/developers/api/
//   - Payments JS API: https://help.sumit.co.il/he/articles/5893615-payments-javascript-api
//   - Charge via API:  https://help.sumit.co.il/he/articles/5833033
//
// Card data never touches our server: the browser tokenizes via Sumit's
// payments.js (OfficeGuy.Payments.Tokenize) into a SINGLE-USE token; we forward
// only that token to saveCard().
//
// Field names below are confirmed against Sumit's Swagger for
// billing/paymentmethods/setforcustomer and billing/payments/charge. Both
// endpoints are "additional properties forbidden", so only documented fields are
// sent (an undocumented field like Amount/IdempotencyKey/Item.ExemptVAT gets the
// whole request rejected). The adapter is gated behind PAYMENT_PROVIDER=sumit.
//
// Env required:
//   SUMIT_COMPANY_ID       (number)  — your company id
//   SUMIT_API_KEY          (secret)  — private API key (server only, never client)
//   SUMIT_API_PUBLIC_KEY   (public)  — public key for the browser tokenizer
//   SUMIT_BASE_URL         (optional) default https://api.sumit.co.il
//   SUMIT_MERCHANT_NUMBER  (optional) Shva terminal/merchant number — only needed
//                                     when the company has multiple merchants
//                                     ("רב-מוטב/רב-ספק") defined. Sent on charge.
//                                     NOTE: setforcustomer has no such field, so
//                                     card-on-file (saveCard) requires the terminal
//                                     to be configured as single-merchant.

const BASE_URL = process.env.SUMIT_BASE_URL || 'https://api.sumit.co.il';

function credentials() {
  return {
    CompanyID: Number(process.env.SUMIT_COMPANY_ID || 0),
    APIKey: process.env.SUMIT_API_KEY || '',
  };
}

function merchantNumber() {
  const m = (process.env.SUMIT_MERCHANT_NUMBER || '').trim();
  return m || null;
}

// All OfficeGuy calls are POST JSON with a Credentials object; responses look
// like { Status: 0, UserErrorMessage, Data: {...} }. Status success is 0 (also
// seen as the string "Success" in some surfaces) — anything else is an error.
function isSuccessStatus(status) {
  return status === 0 || status === '0' || status === 'Success';
}

async function post(path, body) {
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(Object.assign({ Credentials: credentials() }, body)),
    });
  } catch (err) {
    return { ok: false, error: 'Sumit network error: ' + (err.message || err) };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
  if (!res.ok) return { ok: false, error: 'Sumit HTTP ' + res.status + ': ' + text, json };
  if (json && json.Status != null && !isSuccessStatus(json.Status)) {
    return { ok: false, error: json.UserErrorMessage || ('Sumit status ' + json.Status), json };
  }
  return { ok: true, json, data: (json && json.Data) || {} };
}

function publicConfig() {
  return {
    provider: 'sumit',
    companyId: process.env.SUMIT_COMPANY_ID || '',
    apiPublicKey: process.env.SUMIT_API_PUBLIC_KEY || '',
  };
}

// Store the card on a Sumit customer (card-on-file) using the single-use token,
// so it can be charged later for the final weighed amount.
// Endpoint: billing/paymentmethods/setforcustomer  (request: Customer + SingleUseToken).
// Response: Data.CustomerID, Data.PaymentMethod.{CreditCard_LastDigits, CreditCard_Brand}.
async function saveCard({ singleUseToken, customer } = {}) {
  if (!singleUseToken) return { ok: false, error: 'missing token' };
  const c = customer || {};
  const r = await post('/billing/paymentmethods/setforcustomer/', {
    Customer: {
      Name: c.fullName || '',
      EmailAddress: c.email || '',
      Phone: c.phone || '',
      SearchMode: 0, // 0 = Automatic (match-or-create)
    },
    SingleUseToken: singleUseToken,
  });
  if (!r.ok) return r;
  const d = r.data;
  const pm = d.PaymentMethod || {};
  return {
    ok: true,
    customerRef: String(d.CustomerID || ''),
    cardLast4: pm.CreditCard_LastDigits || '',
    brand: pm.CreditCard_Brand || pm.CreditCard_Type || '',
  };
}

// Charge the saved card for the final amount; Sumit issues the tax document.
// Endpoint: billing/payments/charge. The total is DERIVED from Items
// (UnitPrice × Quantity) — there is no top-level Amount field. VAT is handled at
// the document level via VATIncluded (prices are gross); Sumit has no per-line
// VAT-exemption field on this endpoint (see VAT note below).
// Response: Data.Payment.ID, Data.DocumentID, Data.DocumentDownloadURL.
async function charge({ customerRef, amountAgorot, description, items } = {}) {
  if (!customerRef) return { ok: false, error: 'missing customerRef' };
  const amount = Number(amountAgorot || 0) / 100;
  if (!(amount > 0)) return { ok: false, error: 'invalid amount' };

  const lineItems = (items && items.length)
    ? items.map((it) => {
      const qty = it.quantity || 1;
      return {
        Item: { Name: it.name },
        Quantity: qty,
        UnitPrice: it.lineTotalAgorot != null ? (it.lineTotalAgorot / 100) / qty : undefined,
      };
    })
    : [{ Item: { Name: description || 'הזמנה' }, Quantity: 1, UnitPrice: amount }];

  const payload = {
    Customer: { ID: Number(customerRef) || customerRef }, // empty PaymentMethod ⇒ use customer's saved card
    Items: lineItems,
    // Web prices are VAT-inclusive; Sumit breaks out VAT on the document at the
    // company rate. Per-line VAT exemption (produce exempt, wine taxable) is NOT
    // expressible on this endpoint — it must be configured on the catalog Item in
    // Sumit, or handled by issuing the exempt and taxable lines on separate
    // documents. TODO before going live with mixed VAT carts.
    VATIncluded: true,
    SendDocumentByEmail: true,
  };
  const m = merchantNumber();
  if (m) payload.MerchantNumber = m; // multi-merchant terminals only

  const r = await post('/billing/payments/charge/', payload);
  if (!r.ok) return r;
  const d = r.data;
  const payment = d.Payment || {};
  return {
    ok: true,
    paymentRef: String(payment.ID || ''),
    invoiceRef: String(d.DocumentID || ''),
    invoiceUrl: d.DocumentDownloadURL || '',
  };
}

// Sumit has no billing/payments/refund endpoint. Refunds are issued in Sumit's UI
// (credit document / זיכוי) for now; surface a clear error rather than 404 an API.
async function refund() {
  return { ok: false, error: 'refund not supported via Sumit API — issue a credit document in Sumit' };
}

module.exports = { publicConfig, saveCard, charge, refund };
