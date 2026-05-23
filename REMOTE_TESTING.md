# Remote testing environment

This project can use Vercel Preview Deployments as the remote test environment.
That keeps testing close to production because the static pages and `/api/*`
serverless functions run on the same platform used for production.

## Recommended setup

Use two Google Sheets files:

- Production sheet: real products and real orders.
- Testing sheet: copied from production, safe for test orders.

Share both sheets with the same Google service account, or create a separate
service account for testing if you want stricter separation.

## Vercel environments

In Vercel, open the project and go to **Settings > Environment Variables**.

Add production variables with the **Production** environment selected:

- `SPREADSHEET_ID`: production Google Sheet ID
- `GOOGLE_CREDENTIALS`: production service account JSON

Add testing variables with the **Preview** environment selected:

- `SPREADSHEET_ID`: testing Google Sheet ID
- `GOOGLE_CREDENTIALS`: testing service account JSON

With this setup:

- Deployments from `main` use the production sheet.
- Pull requests and non-production branches use the testing sheet.

## Testing flow

1. Create a branch for the change.
2. Push the branch to GitHub.
3. Vercel creates a Preview Deployment automatically.
4. Open the preview URL from the Vercel deployment page.
5. Test the landing page at `/`.
6. Test the order form at `/order/`.
7. Submit a test order and confirm it appears in the testing Google Sheet.
8. Merge to `main` only after the preview passes.

## Stable testing domain

For a stable test URL, add this custom domain in Vercel:

- `test.prinuk.co.il`

Point the domain to Vercel from DNS, then assign it to the preview or staging
branch deployment you want to test.

Recommended test URLs:

- Landing page: `https://test.prinuk.co.il/`
- Order form: `https://test.prinuk.co.il/order/`

Keep production on:

- Landing page: `https://prinuk.co.il/`
- Order form: `https://order.prinuk.co.il/`

This keeps the production shortcut domain `order.prinuk.co.il` unchanged while
still giving testers a stable and obvious URL for the order form.

## What not to do

Do not test new changes against the production Google Sheet. The order API
writes directly to the configured sheet, so test submissions are real writes.
