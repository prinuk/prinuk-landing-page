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
function trimNum(n) { return +Number(n).toFixed(3); }
// The exact line total (₪); prefer the stored agorot to avoid any drift.
function lineIlsOf(it) {
  return round2(it.lineTotalAgorot != null
    ? it.lineTotalAgorot / 100
    : (Number(it.unitPriceAgorot || 0) / 100) * (it.quantity || 1));
}
// Pick the { description, quantity, unitCost } for a line. Two rules:
// 1) The line total MUST be exact — Cardcom recomputes UnitCost × Quantity and a
//    rounded per-unit price drifts over a big order ("Total items not equal to
//    some form of payment"). So we only use a real (qty, unitCost) when it
//    reconciles exactly to the line total; otherwise Quantity = 1 with the total.
// 2) Weight-priced items are BILLED BY KG — show "kg × ₪/kg" in the description
//    (Quantity stays 1 so we never send a fractional Cardcom quantity).
function lineRepr(it, lineIls) {
  if (it.isWeight && it.weightKg > 0 && it.unitPriceAgorot > 0) {
    const ppk = round2(it.unitPriceAgorot / 100); // price per kg
    return { desc: it.name + ' · ' + trimNum(it.weightKg) + ' ק״ג × ₪' + ppk.toFixed(2), quantity: 1, unitCost: lineIls };
  }
  const qty = Number(it.quantity) || 1;
  const u = round2((it.unitPriceAgorot || 0) / 100);
  if (!it.isWeight && qty > 0 && u > 0 && round2(qty * u) === lineIls) {
    return { desc: it.name, quantity: qty, unitCost: u };
  }
  return { desc: it.name + (qty !== 1 ? ' × ' + trimNum(qty) : ''), quantity: 1, unitCost: lineIls };
}
function toProducts(items, description) {
  const list = (items && items.length) ? items : null;
  if (!list) {
    return [{ Description: description || 'הזמנה', Quantity: 1, IsVatFree: true }];
  }
  return list.map((it) => {
    const lineIls = lineIlsOf(it);
    const rep = lineRepr(it, lineIls);
    return {
      Description: rep.desc,
      Quantity: rep.quantity,
      UnitCost: rep.unitCost,
      TotalLineCost: lineIls,
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

// Map an external-payment method key → Cardcom's pre-defined payment-account
// running number (מס' רץ under הגדרות → מסמכים → אמצעי תשלום נוספים). These are
// Cardcom defaults; override per-terminal via CARDCOM_PAY_ACCOUNTS (JSON).
function payMethodAccounts() {
  try {
    const j = JSON.parse(process.env.CARDCOM_PAY_ACCOUNTS || '');
    if (j && typeof j === 'object') return j;
  } catch (e) { /* use defaults */ }
  return { transfer: 31, bit: 28, paybox: 27, paypal: 32 };
}
function payMethodAccountId(method) {
  const id = payMethodAccounts()[String(method || '')];
  return id != null ? Number(id) : null;
}

// InvoiceLines[] for CreateTaxInvoice — per-line IsVatFree drives mixed VAT;
// prices are VAT-inclusive (account "prices include VAT"). Price = unit price.
function toInvoiceLines(items, description) {
  const list = (items && items.length) ? items : null;
  if (!list) return [{ Description: description || 'הזמנה', Quantity: 1, IsVatFree: true, Price: 0 }];
  return list.map((it) => {
    const lineIls = lineIlsOf(it);
    const rep = lineRepr(it, lineIls);
    return {
      Description: rep.desc,
      Quantity: rep.quantity,
      IsVatFree: it.vatExempt !== false,
      Price: rep.unitCost,
      TotalLineCost: lineIls,
    };
  });
}

// Issue a proper חשבונית מס קבלה for an order paid OUTSIDE Cardcom, recording
// the real method (bank transfer / Bit / Paybox …) via CustomLines so the doc
// shows "אופן התשלום: …" and it's booked to its own account (NOT cash).
// invoiceType: 1 = חשבונית מס קבלה (default), 305 = חשבונית מס, 400 = קבלה.
async function createTaxInvoice({ customer, items, description, externalId, invoiceType, payMethodId, cash, dealNumber, reference, amountAgorot, sendByEmail } = {}) {
  const c = customer || {};
  const body = {
    TerminalNumber: terminal(),
    ApiName: apiName(),
    ApiPassword: apiPassword(),
    InvoiceType: String(invoiceType || 1),
    InvoiceHead: {
      CustName: c.fullName || c.name || 'לקוח',
      Email: c.email || '',
      SendByEmail: sendByEmail === true && !!c.email,
      CustMobilePH: c.phone || '',
      Languge: 'he',
      ExternalId: externalId || '',
      Comments: description || '',
    },
    InvoiceLines: toInvoiceLines(items, description),
  };
  if (dealNumber) {
    // Link to an existing credit-card transaction (already charged) → the
    // receipt documents that charge without billing again.
    body.DealNumbers = [{ DealNumber: Number(dealNumber) }];
  } else if (cash) {
    // Cash payment → the built-in Cash field (shows "אופן התשלום: מזומן").
    body.Cash = round2(Number(amountAgorot || 0) / 100);
  } else if (payMethodId != null) {
    body.CustomLines = [{
      TransactionID: Number(payMethodId),
      TranDate: new Date().toISOString().slice(0, 10),
      // Leave Description empty so the doc shows the account name (e.g. הפקדה
      // בנקאית from TransactionID) as "אופן התשלום"; the reference goes in asmacta.
      Description: '',
      asmacta: reference || '',
      Sum: round2(Number(amountAgorot || 0) / 100),
    }];
  }
  const r = await post('/api/v11/Documents/CreateTaxInvoice', body);
  if (!r.ok) return r;
  const d = r.json;
  if (d && d.ResponseCode != null && Number(d.ResponseCode) !== 0) {
    return { ok: false, error: 'Cardcom ' + d.ResponseCode + ': ' + (d.Description || '') };
  }
  return {
    ok: true,
    invoiceRef: String(d.InvoiceNumber || ''),
    invoiceUrl: d.InvoiceLink || '',
    allocationNumber: d.TaxAuthorityAllocationNumber || '',
    json: r.json,
  };
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
  createTaxInvoice, payMethodAccountId,
  createLowProfile, getLowProfileResult,
};
