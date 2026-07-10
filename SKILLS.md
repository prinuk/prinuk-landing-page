# SKILLS.md — Prinuk project working notes (for the assistant)

Durable, reusable knowledge for working on **Prinuk** — a live Hebrew/RTL premium
fruit & vegetable ordering site. Not a play-by-play; the things that save time and
prevent mistakes. Verify against current code before relying on any file:line.

---

## 1. Repo & git workflow

- One repo: `git@github.com:prinuk/prinuk-landing-page.git`. Two branches:
  - **`dev`** — all development happens here.
  - **`main`** — production; Vercel deploys `main` on push (runs `npm run build`).
- **Never push to `main` without an explicit request.** Normal loop:
  1. On `dev`: edit → `npm run lint` + `npm run build` → `git commit` → `git push origin dev`.
  2. When asked to merge: `git checkout main` → `git pull --ff-only origin main`
     → `git merge --no-ff origin/dev -m "..."` → lint+build → `git push origin main`
     → `git checkout dev`.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- History note: there used to be TWO git *worktrees* — `prinuk-landing-page` (main)
  and `prinuk-replatform` (dev). They were **consolidated into one folder**
  (`~/Downloads/prinuk-landing-page`) via `git worktree remove`. If a session's
  configured working dirs still point at `prinuk-replatform`, that path may not
  exist — use `prinuk-landing-page` and `git checkout` to switch branches.
- `public/` is gitignored (build output). Stray `.bak` files have snuck into
  history before — don't commit them; strip them from merges.

## 2. Stack & where things live

- Vanilla JS single-file frontends (no framework, no build for them):
  - `order/index.html` (~8k lines) — customer ordering page (RTL Hebrew).
  - `team/index.html` (~3k+ lines) — team/back-office dashboard. One giant inline
    `<style>` + `<script>`. Append CSS near the end so it wins the cascade.
- Vercel serverless functions: `api/*.js` (e.g. `api/dashboard.js`, `api/order.js`,
  `api/payment-init.js`, `api/catalog.js`).
- **`lib/store.js`** — the DB core (Drizzle): products/orders/items/payments,
  order build/validate, charge, invoices, reports. Most business logic lives here.
- `lib/sheets.js` — shared helpers (parseProducts, `validateAndBuildOrder`,
  `resolveDelivery`, `formatEstimatedTotal`, `formatMoney`, `getUnitType`,
  `normalizeProductName`, `UNIT_WEIGHT_ESTIMATES_KG` — now unused as a source).
- `lib/payments/` — provider-agnostic adapter (`index.js`, `mock.js`, `sumit.js`,
  `cardcom.js`). `PAYMENT_PROVIDER` env selects; `paymentsEnabled()`.
- PDFs: `lib/order-pdf.js` (customer confirmation PDF), `lib/orders-pdf.js` (team
  batch/print PDF), `lib/pdf-render.js` (`renderHtmlToPdf` — shared Chromium via
  `@sparticuz/chromium` + puppeteer-core). `lib/email.js` (Resend), `lib/telegram.js`.
- `lib/sale.js` — `publishSale` (weekly publish from a pricing spreadsheet).
- **Money is integer agorot everywhere** (`fromAgorot`/`toAgorot`). Weights numeric kg.
- **DUPLICATED code (keep in sync):** `formatEstimatedTotal` + `buildAddressText`
  exist in BOTH `lib/sheets.js` and `lib/order-pdf.js`.
- `formatMoney` already prepends `₪` — never add another `₪` in front of it.
- `CATEGORY_ORDER = ['ירקות','פירות','עלים','מיוחדים','יינות ואלכוהול']`
  (`getItems` sorts by this then sortOrder).

## 3. Database & migrations (Drizzle + Postgres/Supabase)

- Schema: `lib/db/schema.js`. Client: `lib/db/client.js` (pooled runtime conn).
- Migrations live in `./drizzle`. Config `drizzle.config.js` (out `./drizzle`).
  - `npm run db:generate` — offline, diffs schema vs migrations (no DB needed).
  - `npm run db:migrate` — applies to the **dev** DB (uses `.env`, `DIRECT_URL`).
  - `npm run db:migrate:prod` — applies to **prod** (uses `.env.prod`).
  - DDL needs the **session** connection (`DIRECT_URL`, port 5432), not the pooler.
  - `NOTICE: … already exists, skipping` lines are harmless.
- **Order of operations for a new column:** edit schema → `db:generate` → commit the
  new `drizzle/NNNN_*.sql` → **run `db:migrate` / `db:migrate:prod` BEFORE the code
  that uses the column deploys** (Drizzle selects the column; an absent column errors
  the whole query). Migration numbering has reached 0011+ this session.
- `.env` / `.env.prod` (both gitignored) hold `DATABASE_URL`, `DIRECT_URL`, and
  Cardcom creds. **Never paste secrets in chat.** They live only in these files /
  Vercel env.

## 4. Diagnostics (querying prod/dev directly)

Run one-off Node against a DB by sourcing the env first:
```bash
set -a && . ./.env.prod 2>/dev/null; set +a; node -e "
const { db } = require('./lib/db/client');
const { sql } = require('drizzle-orm');
(async()=>{ const r = await db.execute(sql\`select ...\`); (r.rows||r).forEach(...); process.exit(0); })()
  .catch(e=>{console.error(e.message);process.exit(1);});
"
```
- `db.execute` returns `{rows}` on some drivers, a plain array on others → `(r.rows||r)`.
- Enum columns can't be `coalesce`d to arbitrary strings (throws). Cast/handle nulls in JS.
- Numeric columns come back as strings/BigInt — coerce with `+x` before compare (a
  BigInt `===` vs number silently fails, which produced a false "still off" once).
- `order_items` join to `orders` for time (`o.created_at`); the FK column is
  `order_id` (not `"orderId"`).
- Read-only SELECTs are safe. **Writes to prod are consequential — confirm first**,
  show a dry-run/preview, and use `RETURNING` to verify. Prefer targeted updates
  guarded by conditions (e.g. only `payment_status='none'` rows).

## 5. Cardcom payments (v11)

- Provider = `cardcom` (`lib/payments/cardcom.js`). Base `https://secure.cardcom.solutions`,
  paths `/api/v11/...`. Terminals: **192541 = production**, **1000 = preview/test**.
- **Auth:** tokenize/charge use `ApiName` + `TerminalNumber`. **Refunds + documents**
  (`CreateDocument`, `CreateTaxInvoice`, `RefundByTransactionId`) also need
  `ApiPassword` (`CARDCOM_API_PASSWORD`). A wrong password → 604; too many wrong
  attempts → **605 "user blocked, reset password"**.
- **Swagger** (machine-readable, complete except some doc endpoints):
  `https://secure.cardcom.solutions/swagger/v11/swagger.json` — fetch with curl
  (normal UA), parse with node. Zendesk help pages are Cloudflare-403 to WebFetch,
  BUT their JSON API works:
  `https://cardcomapi.zendesk.com/api/v2/help_center/he/articles/{id}.json`
  → `.article.body` (strip HTML). Same for `support.cardcom.solutions`.
- **OPEN FIELDS** = Cardcom's stylable hosted card iframes (low PCI). Field iframes
  MUST have `name` = `CardComCardNumber`/`CardComCvv`/`CardComMasterFrame`. Inner
  ids `#cardNumber`/`#cvvField`. `LowProfile/Create` needs Success/FailedRedirectUrl
  even for postMessage flows.
- **LowProfile/Create** (`CreateLowProfile`) fields: `Operation`, `Amount`,
  `ISOCoinId` (1=ILS), `ReturnValue`, `Success/FailedRedirectUrl`, `WebHookUrl`,
  `Document` (DocumentLP). Operation enum: **`ChargeOnly`, `ChargeAndCreateToken`,
  `CreateTokenOnly`, `SuspendedDeal`, `Do3DSAndSubmit`** (default ChargeOnly). So a
  LowProfile can charge AND issue the invoice in one step.
- **Current model = tokenize-then-charge-later:** checkout uses
  `Operation=CreateTokenOnly` (a J2 verify → token, no charge); the team later
  charges the token via `Transactions/Transaction` (J4) + inline `Document`.
  Charging a saved token **requires `CardExpirationMMYY`** — captured from
  `GetLpResult` `TokenInfo.CardMonth/CardYear`, stored in `payments.card_expiry`.
- Two document endpoints:
  - `Documents/CreateDocument` — `Document.Products[]`; payment methods limited to
    `Cash` + `Cheques[]` + `DealNumbers[]`. No bank-transfer/other field.
  - **`Documents/CreateTaxInvoice`** (classic model, NOT in swagger — see zendesk
    article `25360043043602`): `InvoiceType`, `InvoiceHead`, `InvoiceLines[]`
    (per-line `IsVatFree`, `Price`, `Quantity`, `TotalLineCost`), and payment via
    `Cash`, `Cheques`, **`DealNumbers[]`** (link an existing CC charge — no re-charge),
    and **`CustomLines[]`** = other methods (bank transfer / Bit / Paybox / PayPal)
    keyed by **`TransactionID`** = a pre-defined payment-account "מס' רץ".
    - Set up in admin: **הגדרות → 3.מסמכים → 3.הגדרות העברה להנה"ח → 2.אמצעי תשלום נוספים**.
      Owner terminal defaults: **31=הפקדה בנקאית, 28=BIT, 27=PayBox, 32=PayPal**,
      29=חיוב בנקאי הו"ק, 30=חיוב/זיכוי לקוחות, 33=ניכוי מס במקור, 25=PayMe, 24=Infinity.
    - `CustomLines` fields: `TransactionID`, `TranDate`, `Description` (leave EMPTY so
      the account name shows as "אופן התשלום"), `asmacta` (reference), `Sum`.
  - **InvoiceType codes:** 1=חשבונית מס קבלה, 305=חשבונית מס, 400=קבלה,
    2=חשבונית זיכוי, 3=קבלה מלכ"ר/פטור.
- **VAT:** per-line `IsVatFree` drives mixed exempt/taxable in one doc. Prices are
  VAT-inclusive (account setting "prices include VAT" ON — the reason Sumit was
  rejected: no per-line VAT). Fresh produce is legitimately VAT-exempt.
- **Refund:** `Transactions/RefundByTransactionId` (supports `PartialSum`,
  `CancelOnly`). No dashboard refund button yet.
- **Cannot block Amex/Diners client-side** (brand isn't posted to the parent) — set
  accepted brands on the terminal.

## 6. Invoice-document reconciliation rules (hard-won — money-critical)

Cardcom will **charge the card but reject the document** (returns `DocumentType:
"Error"` / `DocumentNumber 0` with `ResponseCode 0`, or on CreateTaxInvoice the error
**"Total items not equal to some form of payment"**) whenever the document line
items don't total exactly the charged amount. Confirmed root causes + fixes:

1. **Missing (חסר) items** were in the document but not the charge → the doc total
   exceeded the charge. Fix: `buildOrderChargeItems` filters `pickStatus !==
   ITEM_PICK_MISSING`.
2. **Rounding drift:** sending the real integer `Quantity` (units) with a rounded
   per-unit `UnitCost`, Cardcom recomputes `UnitCost × Quantity`, which drifts from
   the weighed line total and accumulates over a big order (e.g. 38 items → ₪0.13 off).
   Fixes (`lib/payments/cardcom.js` `lineRepr`):
   - **Weight-priced lines** → `Quantity = weighed kg`, `UnitCost = ₪/kg`. Cardcom's
     `Quantity` IS a decimal field and uses `TotalLineCost` for decimal quantities,
     so it reconciles. Tolerate a **1-agora** gap (`Math.abs(kg×ppk − line) <= 0.011`).
   - **Unit-priced that reconciles** → real count × unit price.
   - **Anything else** (deals/estimate/fees) → `Quantity = 1` with the exact line
     total. Never append a unit count to a weight line.
   - `TotalLineCost` = exact stored line total (authoritative). The invoice total
     must equal the charge/deal amount to the agora.
- **No unit-of-measure field** on invoice lines → convey it in the Description
  (`… (ק״ג)` / `… (יח׳)`, or `לפי משקל` / `לפי יחידה`).
- **Re-issue a missing invoice** for an already-charged order: `CreateTaxInvoice`
  with `DealNumbers:[{DealNumber: <TranzactionId>}]`, `InvoiceType 1` — links to the
  existing charge, no re-charge. In store as `issueChargedInvoice`; surfaced as a
  payment-panel button ("🧾 הפקת חשבונית להזמנה שחויבה"), with a "send customer
  email?" prompt (skipEmail).
- When a charge succeeds but the invoice fails, **do NOT auto-email the customer** —
  alert + offer retry / explicit "send without invoice" (`send-final-email`).

## 7. Business / domain rules

- **Weight-priced items are charged BY KG:** `actualLineTotalAgorot =
  round(actualWeightKg × unitPriceAgorot)` where `unitPriceAgorot` = price per kg
  (priceUnit `ק״ג`). NOT by units. Estimate = `estimatedWeightKg × price/kg`.
- **Estimate weight (`weightPerUnitKg`) is ADMIN-managed ONLY.** Removed the
  hardcoded `UNIT_WEIGHT_ESTIMATES_KG` fallback AND stopped `publishSale` from
  importing the pricing sheet's "weight" column (which is NOT a per-unit weight and
  clobbered admin values — a publish set e.g. אבטיח 8 → 356). Product list flags
  weight items with no estimate weight (⚠️ חסר משקל משוער) and shows the estimate
  price.
- **Free delivery:** threshold `settings.freeDeliveryThreshold` (**₪300**), fee
  `settings.deliveryFee` (**₪15**) via `resolveDelivery`. Rule: **charge delivery
  only when BOTH the estimate AND the collected total are below the threshold;
  free once either crosses it.** Recomputed at collection (`updateOrderCollection`)
  and in the charge-review (`crRecompute`).
- **Totals:** `actualTotalAgorot` = collected items only (no fee/discount);
  `finalTotal` (mapSummary) = `actualTotal − discount + delivery` (what's billed);
  `grandTotalAgorot` = order-time estimate incl delivery. PDFs' "סה״כ סופי" and
  "לתשלום במסירה" must use **finalTotal** (include delivery), not actualTotal.
- **Order lifecycle:** חדש → בליקוט → נאסף / נאסף חלקית → נשלח / נמסר. Item
  `pickStatus`: `נאסף` (collected) / `חסר` (missing) / null (pending). Missing items
  stay on the order but are never billed.
- **Order origin** (`orders.origin`): `web` (customer) vs `manual` (חשבונית חדשה /
  POS via `createManualOrder`). Manual orders are created already-COLLECTED with
  `pickedAt === createdAt` (exact same timestamp — a reliable fingerprint used to
  backfill origin for pre-feature orders; web orders' pickedAt is always later).
  Dashboard defaults to `web`; counters respect the origin filter.
- **Payment status:** real `paymentStatus` enum (none/authorized/captured/…) plus a
  manual override `paymentStatusManual` ('paid'/'unpaid'/'na'). Display = override
  if set, else captured→paid. Issuing an external invoice marks the order paid.
- **`publishSale`** (weekly): imports prices/departments/units/images from the
  Google Sheet "חישוב מחירים" (`PRICING_SPREADSHEET_ID`), matched by normalized
  name; `dryRun` previews. Does NOT touch `weightPerUnitKg`.
- Email gating: Edge Config flags `sendEmailsProduction` / `sendEmailsPreview`
  (default off). The confirmation email attaches the order PDF; the final email
  attaches a collected-summary PDF + the invoice.

## 8. The team charge-review modal (team/index.html)

- `state.review` drives one modal used for BOTH an existing order's charge and the
  POS new-invoice (`isNew`). Key flags: `hasCard`, `forceCard` (replace saved card),
  `docMode` (issue external חשבונית מס קבלה instead of charging), `docMethod`
  (cash/transfer/bit/paybox/paypal), `deliveryAuto`.
- Button label + `doCharge` follow the **current payment method**, not whether a card
  is saved (switching to מזומן shows "issue invoice" even with a card on file).
- `buildOrderChargeItems` (store) is the single source of charge/invoice line items;
  shared by card charge, external document, and re-issue.

## 9. Owner / working style (Yoni, business owner, Hebrew/RTL)

- Wants direct action and usually says "merge to main" right after accepting a
  change. Reviews on the Vercel dev preview; tests real card charges himself on the
  preview/prod terminal.
- **Dislikes the AskUserQuestion tool** — clarify in plain text instead.
- Explain before large/risky (esp. money) changes; then build on dev for him to test.
- Optimize for order completion, mobile-first, RTL correctness, premium-grocery feel
  (see CLAUDE.md / AGENTS.md). Customer-facing text is Hebrew; no technical errors to
  customers.

## 10. Still open / TODO (as of this session)

- **Immediate-charge for צור חשבונית** (approved, not built): use LowProfile
  `Operation=ChargeAndCreateToken` + Amount (+ deal-linked `CreateTaxInvoice`) so POS
  credit charges in one J4 (no CreateTokenOnly J2). Wrinkle: OPEN FIELDS locks the
  amount at field-init, so guard against the team editing items after the card is
  entered (re-init if the total changed). Build on dev; test on terminal 1000.
- No dashboard **refund** action yet (Cardcom refund exists in the adapter).
