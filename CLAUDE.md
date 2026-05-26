# Project guidance for Claude

## Git workflow (IMPORTANT)
- **Never push directly to `main`.** Always push to `dev` unless the user
  explicitly says to push to `main` (or to merge/sync into `main`).
- `main` is the production/deploy branch; changes reach it only when the
  user asks to merge `dev` → `main`.

## Build / deploy
- Deploy is via Vercel; it runs `npm run build` (`node scripts/build.js`),
  which validates the catalog and writes static output to `public/`.
- `public/` is gitignored and rebuilt on deploy — don't commit it.
- A failing `build.js` assertion fails the whole deploy, so run
  `npm run build` and `npm run lint` locally before pushing.

## Unit weight estimates (lib/sheets.js)
- `UNIT_WEIGHT_ESTIMATES_KG` is looked up by exact, **normalized** product
  name (`normalizeProductName` strips `״`/`׳` quotes, collapses whitespace).
- Map keys must therefore omit gershayim — e.g. the key for the product
  "תפו״א אדום (תפזורת)" is `'תפוא אדום (תפזורת)'`. A key containing `״`
  will never match.
