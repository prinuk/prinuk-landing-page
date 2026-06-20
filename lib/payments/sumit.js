'use strict';
// Sumit (sumit.co.il / "OfficeGuy") payment adapter.
//
// Docs:
//   - REST API:        https://app.sumit.co.il/developers/api/
//   - Payments JS API: https://help.sumit.co.il/he/articles/5893615-payments-javascript-api
//   - Charge via API:  https://help.sumit.co.il/he/articles/5833033
//
// Card data never touches our server: the browser tokenizes via Sumit's
// payments.js (OfficeGuy.Payments.BindFormSubmit) into a SINGLE-USE token
// ("og-token"); we forward only that token to saveCard().
//
// ⚠️ The exact endpoint paths and field names below follow the public docs but
// MUST be confirmed against your account's API reference once SUMIT_* creds
// exist — every uncertain spot is tagged `// VERIFY`. The whole adapter is gated
// behind PAYMENT_PROVIDER=sumit, so the live site is unaffected until then.
//
// Env required:
//   SUMIT_COMPANY_ID       (number)  — your company id
//   SUMIT_API_KEY          (secret)  — private API key (server only, never client)
//   SUMIT_API_PUBLIC_KEY   (public)  — public key for the browser tokenizer
//   SUMIT_BASE_URL         (optional) default https://api.sumit.co.il

const BASE_URL = process.env.SUMIT_BASE_URL || 'https://api.sumit.co.il';

function credentials() {
  return {
    CompanyID: Number(process.env.SUMIT_COMPANY_ID || 0),
    APIKey: process.env.SUMIT_API_KEY || '',
  };
}

// All OfficeGuy calls are POST JSON with a Credentials object; responses look
// like { Status: 0, UserErrorMessage, Data: {...} } (Status 0 = success).
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
  if (json && json.Status != null && json.Status !== 0) {
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
async function saveCard({ singleUseToken, customer } = {}) {
  if (!singleUseToken) return { ok: false, error: 'missing token' };
  const c = customer || {};
  const r = await post('/billing/paymentmethods/setforcustomer/', { // VERIFY path
    Customer: {
      Name: c.fullName || '',
      EmailAddress: c.email || '',
      Phone: c.phone || '',
      SearchMode: 0, // VERIFY: match-or-create by email
    },
    SingleUseToken: singleUseToken,
    UpdateCustomerByEmail: true,
  });
  if (!r.ok) return r;
  const d = r.data;
  return {
    ok: true,
    customerRef: String(d.CustomerID || (d.Customer && d.Customer.ID) || ''), // VERIFY
    cardLast4: d.CreditCard_LastDigits || d.LastDigits || '', // VERIFY
    brand: d.CreditCard_Type || '', // VERIFY
  };
}

// Charge the saved card for the final amount; Sumit issues the tax document.
async function charge({ customerRef, amountAgorot, description, items, idempotencyKey } = {}) {
  if (!customerRef) return { ok: false, error: 'missing customerRef' };
  const amount = Number(amountAgorot || 0) / 100;
  if (!(amount > 0)) return { ok: false, error: 'invalid amount' };

  const lineItems = (items && items.length)
    ? items.map((it) => ({
      Item: { Name: it.name },
      Quantity: it.quantity || 1,
      UnitPrice: it.lineTotalAgorot != null ? (it.lineTotalAgorot / 100) / (it.quantity || 1) : undefined,
    }))
    : [{ Item: { Name: description || 'הזמנה' }, Quantity: 1, UnitPrice: amount }];

  const r = await post('/billing/payments/charge/', { // VERIFY path
    Customer: { ID: Number(customerRef) || customerRef }, // VERIFY: charge by stored customer
    Items: lineItems,
    Amount: amount, // VERIFY: whether Amount is required or derived from Items
    Currency: 'ILS',
    IdempotencyKey: idempotencyKey, // VERIFY supported
    SendDocumentByEmail: true,
  });
  if (!r.ok) return r;
  const d = r.data;
  return {
    ok: true,
    paymentRef: String(d.PaymentID || d.ID || ''), // VERIFY
    invoiceRef: String(d.DocumentID || ''), // VERIFY
    invoiceUrl: d.DocumentDownloadURL || d.DocumentURL || '', // VERIFY
  };
}

async function refund({ paymentRef, amountAgorot, idempotencyKey } = {}) {
  if (!paymentRef) return { ok: false, error: 'missing paymentRef' };
  const r = await post('/billing/payments/refund/', { // VERIFY path
    PaymentID: Number(paymentRef) || paymentRef,
    Amount: amountAgorot != null ? Number(amountAgorot) / 100 : undefined,
    IdempotencyKey: idempotencyKey,
  });
  if (!r.ok) return r;
  const d = r.data;
  return { ok: true, refundRef: String(d.RefundID || d.ID || '') };
}

module.exports = { publicConfig, saveCard, charge, refund };
