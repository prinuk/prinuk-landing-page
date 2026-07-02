'use strict';
// Cardcom (cardcom.solutions) payment adapter — v11 JSON API.
//
// Docs:  https://secure.cardcom.solutions/swagger/index.html  (ReDoc)
// Spec:  https://secure.cardcom.solutions/swagger/v11/swagger.json  (OpenAPI 3.0)
//
// WHY Cardcom (vs Sumit): the invoice line item (`Products[].IsVatFree`) supports
// MIXED VAT in one tax document — exempt produce + taxable wine on the same
// חשבונית מס — which Sumit's charge API could not do. Cardcom also auto-issues the
// tax-authority allocation number (מספר הקצאה), has a real refund endpoint, and
// supports Apple/Google Pay + Bit.
//
// MODEL (tokenize-then-charge-final, matches lib/payments contract):
//   1. Customer card is tokenized client-side (Cardcom OPEN FIELDS — PCI-safe,
//      card data never hits our server). The browser returns a reusable token.
//   2. saveCard() stores that token as the card-on-file ref (customerRef).
//   3. After picking/weighing, charge() bills the EXACT final amount via
//      Transactions/Transaction (Token + Document) → Cardcom issues the invoice.
//   4. refund() via Transactions/RefundByTransactionId (supports partial).
//
// Money: callers pass integer agorot; Cardcom wants decimal ILS, so /100 here.
//
// Env:
//   CARDCOM_TERMINAL       (number)  — terminal number
//   CARDCOM_API_NAME       (secret)  — API user name (server only)
//   CARDCOM_API_PASSWORD   (secret)  — API password (server only; refunds/documents)
//   CARDCOM_API_PUBLIC     (public)  — public key for the browser OPEN FIELDS tokenizer
//   CARDCOM_BASE_URL       (optional) default https://secure.cardcom.solutions

const BASE_URL = process.env.CARDCOM_BASE_URL || 'https://secure.cardcom.solutions';

function terminal() { return Number(process.env.CARDCOM_TERMINAL || 0); }
function apiName() { return process.env.CARDCOM_API_NAME || ''; }
function apiPassword() { return process.env.CARDCOM_API_PASSWORD || ''; }

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

// All v11 calls are POST JSON. Success is ResponseCode === 0 (700/701 are also
// success for J2/J5 — we use J4 capture, so 0 is what we expect).
async function post(path, body) {
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: 'Cardcom network error: ' + (err.message || err) };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
  if (!res.ok) return { ok: false, error: 'Cardcom HTTP ' + res.status + ': ' + text, json };
  const code = json && json.ResponseCode;
  if (json && code != null && code !== 0 && code !== 700 && code !== 701) {
    return { ok: false, error: (json.Description || ('Cardcom ResponseCode ' + code)), json };
  }
  return { ok: true, json: json || {} };
}

function publicConfig() {
  // Client-safe values for the OPEN FIELDS iframes (no secrets). The browser only
  // needs the terminal (for the optional wallet iframe) + the base URL; the
  // sensitive work happens server-side against the LowProfile we create.
  return {
    provider: 'cardcom',
    terminalNumber: process.env.CARDCOM_TERMINAL || '',
    baseUrl: BASE_URL,
  };
}

// Map our order lines → Cardcom invoice products. We send Quantity + TotalLineCost
// (+ UnitCost) so weight-priced decimal quantities never drift on rounding, and
// per-line IsVatFree so exempt produce and taxable items share one document.
function toProducts(items, description) {
  const list = (items && items.length) ? items : null;
  if (!list) {
    return [{ Description: description || 'הזמנה', Quantity: 1, IsVatFree: true }];
  }
  return list.map((it) => {
    const qty = it.quantity || 1;
    const lineIls = it.lineTotalAgorot != null
      ? it.lineTotalAgorot / 100
      : (Number(it.unitPriceAgorot || 0) / 100) * qty;
    return {
      Description: it.name,
      Quantity: qty,
      UnitCost: round2(qty ? lineIls / qty : lineIls),
      TotalLineCost: round2(lineIls),
      IsVatFree: it.vatExempt !== false,
    };
  });
}

// Build the tax document attached to a charge / created standalone.
// docType — a DocumentType enum name (e.g. 'TaxInvoice' for a חשבונית מס with no
//   receipt line); omit to use the terminal default (typically חשבונית מס/קבלה).
// paymentNote — free text appended to the document comments (e.g. how an external
//   payment was made: "העברה בנקאית — אסמכתא 12345").
function buildDocument({ customer, items, description, externalId, docType, paymentNote, sendByEmail } = {}) {
  const c = customer || {};
  const products = toProducts(items, description);
  const comments = [description, paymentNote].map((s) => String(s || '').trim()).filter(Boolean).join(' | ');
  const doc = {
    Name: c.fullName || c.name || 'לקוח',
    Email: c.email || '',
    // Cardcom emails the document to the customer unless suppressed (we send our
    // own final email with the collected summary + invoice attached instead).
    IsSendByEmail: sendByEmail === false ? false : !!(c.email),
    Mobile: c.phone || '',
    Comments: comments,
    ExternalId: externalId || '',
    // Whole-document exempt only when EVERY line is exempt; otherwise per-line
    // IsVatFree on each product drives the mixed-VAT calculation.
    IsVatFree: !!(items && items.length && items.every((it) => it.vatExempt !== false)),
    Products: products,
  };
  // DocumentTypeToCreate default (unset → 0) resolves from the admin panel. Set it
  // to force a specific type (e.g. 'TaxInvoice' — a tax invoice with no receipt/
  // payment line, for orders paid outside Cardcom by transfer/Bit/cash).
  if (docType) doc.DocumentTypeToCreate = docType;
  return doc;
}

// Step 1 of OPEN FIELDS card entry: create a LowProfile "deal" the browser
// iframes run against. For our save-card model we use Operation=CreateTokenOnly,
// so the customer's card is tokenized (card-on-file) WITHOUT a charge; the final
// amount is billed later by charge(). ReturnValue carries our order code back.
async function createLowProfile({ operation, amountAgorot, description, returnValue, webhookUrl, successUrl, failedUrl } = {}) {
  // SuccessRedirectUrl/FailedRedirectUrl are required by LowProfile/Create even
  // though OPEN FIELDS uses postMessage (not a redirect) — send placeholders.
  const fallbackUrl = (process.env.CARDCOM_REDIRECT_URL || 'https://order.prinuk.co.il/');
  const r = await post('/api/v11/LowProfile/Create', {
    TerminalNumber: terminal(),
    ApiName: apiName(),
    Operation: operation || 'CreateTokenOnly',
    Amount: round2(Number(amountAgorot || 0) / 100), // informational for token-only
    ISOCoinId: 1, // ILS
    Language: 'he',
    ProductName: description || 'הזמנה',
    ReturnValue: returnValue || '',
    SuccessRedirectUrl: successUrl || fallbackUrl,
    FailedRedirectUrl: failedUrl || fallbackUrl,
    WebHookUrl: webhookUrl || undefined,
  });
  if (!r.ok) return r;
  const d = r.json;
  return { ok: true, lowProfileId: String(d.LowProfileId || ''), url: d.Url || '', urlToBit: d.UrlToBit || '' };
}

// Step 2: after the browser finishes OPEN FIELDS, resolve the LowProfile to get
// the reusable token (TokenInfo.Token) — and, if the operation also charged,
// the transaction + document info.
async function getLowProfileResult(lowProfileId) {
  if (!lowProfileId) return { ok: false, error: 'missing lowProfileId' };
  const r = await post('/api/v11/LowProfile/GetLpResult', {
    TerminalNumber: terminal(),
    ApiName: apiName(),
    LowProfileId: String(lowProfileId),
  });
  if (!r.ok) return r;
  const d = r.json;
  const tok = d.TokenInfo || {};
  const tran = d.TranzactionInfo || {};
  // Card expiry as MMYY — Cardcom requires it when charging the saved token later.
  const mm = tok.CardMonth || tran.CardMonth;
  const yy = tok.CardYear || tran.CardYear;
  const pad2 = (n) => String(n == null ? '' : n).replace(/\D/g, '').slice(-2).padStart(2, '0');
  const cardExpiry = (mm != null && yy != null) ? (pad2(mm) + pad2(yy)) : '';
  return {
    ok: true,
    token: tok.Token || tran.Token || '',
    cardExpiry,
    cardLast4: tran.Last4CardDigitsString || (tran.Last4CardDigits ? String(tran.Last4CardDigits) : ''),
    paymentRef: tran.TranzactionId ? String(tran.TranzactionId) : '',
    invoiceUrl: tran.DocumentUrl || '',
    raw: d,
  };
}

// Store the card on file. With OPEN FIELDS the browser doesn't hand us a token
// directly — it runs the LowProfile we created, so we resolve that LowProfile id
// here and adopt its reusable token as our customerRef. (The client sends the
// LowProfileId as the order's paymentToken.)
async function saveCard({ singleUseToken, token, lowProfileId, customer } = {}) {
  void customer;
  const lp = lowProfileId || token || singleUseToken;
  if (!lp) return { ok: false, error: 'missing lowProfileId' };
  const r = await getLowProfileResult(lp);
  if (!r.ok) return r;
  if (!r.token) return { ok: false, error: 'no token on LowProfile result (card not saved)' };
  return { ok: true, customerRef: String(r.token), cardExpiry: r.cardExpiry || '', cardLast4: r.cardLast4 || '', brand: '' };
}

// Charge the saved token for the final amount and issue the invoice in one call.
async function charge({ customerRef, cardExpiration, amountAgorot, description, items, customer, idempotencyKey, externalId } = {}) {
  if (!customerRef) return { ok: false, error: 'missing customerRef' };
  const amount = round2(Number(amountAgorot || 0) / 100);
  if (!(amount > 0)) return { ok: false, error: 'invalid amount' };

  const r = await post('/api/v11/Transactions/Transaction', {
    TerminalNumber: terminal(),
    ApiName: apiName(),
    Amount: amount,
    Token: String(customerRef),
    // Cardcom requires the card expiry (MMYY) when charging a saved token.
    CardExpirationMMYY: cardExpiration || undefined,
    ISOCoinId: 1, // ILS
    ExternalUniqTranId: idempotencyKey || undefined, // Cardcom-side dedup
    Document: buildDocument({ customer, items, description, externalId }),
  });
  if (!r.ok) return r;
  const d = r.json;
  return {
    ok: true,
    paymentRef: String(d.TranzactionId || ''),
    invoiceRef: String(d.DocumentNumber || ''),
    invoiceUrl: d.DocumentUrl || '',
    token: d.Token || '',
    json: r.json, // logged in the transactions table for debugging
  };
}

// Issue a tax document WITHOUT a card charge (cash orders / POS new invoice /
// an order paid externally by transfer, Bit, etc.). docType/paymentNote let the
// caller force a חשבונית מס and note how it was paid.
async function createDocument({ customer, items, description, externalId, docType, paymentNote, sendByEmail } = {}) {
  const r = await post('/api/v11/Documents/CreateDocument', {
    ApiName: apiName(),
    ApiPassword: apiPassword(),
    Document: buildDocument({ customer, items, description, externalId, docType, paymentNote, sendByEmail }),
  });
  if (!r.ok) return r;
  const d = r.json;
  return { ok: true, invoiceRef: String(d.DocumentNumber || ''), invoiceUrl: d.DocumentUrl || '' };
}

// Refund (full or partial) by the original transaction id. Cardcom supports
// partial refunds (PartialSum) and pre-settlement void (CancelOnly).
async function refund({ paymentRef, amountAgorot } = {}) {
  if (!paymentRef) return { ok: false, error: 'missing paymentRef' };
  const r = await post('/api/v11/Transactions/RefundByTransactionId', {
    ApiName: apiName(),
    ApiPassword: apiPassword(),
    TransactionId: Number(paymentRef) || paymentRef,
    PartialSum: amountAgorot != null ? round2(Number(amountAgorot) / 100) : undefined,
  });
  if (!r.ok) return r;
  const d = r.json;
  return { ok: true, refundRef: String(d.TranzactionId || d.NewTranzactionId || '') };
}

module.exports = {
  publicConfig, saveCard, charge, refund, createDocument,
  createLowProfile, getLowProfileResult,
};
