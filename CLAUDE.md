# Project guidance for Claude
@AGENTS.md

# CLAUDE.md
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


## Project Context

This is a premium fruit and vegetable ordering website for customers in Israel.

The goal is not only to make the website look good, but to make the ordering process clear, fast, trustworthy, and easy — especially on mobile.

Most customers will use the website from their phone.

## Brand Direction

The design should feel:

- Fresh
- Premium
- Clean
- Trustworthy
- Simple
- Local and friendly
- High quality, but not heavy or luxury in a cold way

Avoid:

- Generic SaaS/dashboard design
- Too many colors
- Childish design
- Overloaded product cards
- Unnecessary animations
- Complicated checkout flows

## UX Goal

Optimize every design decision for order completion.

The customer should always understand:

1. What products are available
2. What they selected
3. The unit and price
4. The quantity
5. The current order summary
6. How to complete the order
7. What details are missing, if validation fails

Do not make the customer think too much.

## Mobile-First Rules

Always design and test mobile first.

Important mobile rules:

- Buttons must be easy to tap.
- Quantity controls must be large and clear.
- Product cards must be easy to scan.
- Avoid horizontal scrolling.
- Avoid dense layouts.
- Keep the main action easy to find.
- Make sure spacing works well on small screens.
- Hebrew RTL layout must be respected.

## Visual Style

Use a fresh premium grocery style.

Prefer:

- Clean white / cream backgrounds
- Soft green accents
- Subtle shadows
- Rounded but mature corners
- Clear typography hierarchy
- Generous spacing
- Calm, elegant UI
- Simple icons only when useful

Avoid:

- Random gradients
- Too many bright colors
- Heavy borders everywhere
- Tiny text
- Overly playful visuals
- Adding visual elements that do not help the ordering flow

## Product Cards

Product cards should be clean, consistent, and easy to scan.

Each product card should clearly show:

- Product name
- Price
- Unit, for example kg / unit / package
- Quantity controls
- Selected quantity or selected state

Rules:

- Do not overload product cards.
- Keep quantity controls obvious.
- Make selected products visually clear.
- Use consistent spacing and alignment.
- Make product names readable.
- Do not hide important information behind hover states, because many users are on mobile.

## Cart / Order Summary

The customer should always understand what is currently in the order.

The order summary should be:

- Clear
- Easy to review
- Easy to edit
- Not visually overwhelming
- Available at the right moment in the flow

If using a sticky cart/summary, make sure it does not block important content on mobile.

## Checkout / Customer Details

The checkout/details area should feel simple and friendly.

Rules:

- Use clear labels, not only placeholders.
- Required fields should be obvious.
- Validation messages should be human and helpful.
- Do not show technical error messages to customers.
- Keep the form short.
- Use inline validation where possible.

If the customer clicks “Finish order” before filling required details:

Prefer:
- Smooth scroll to the missing details section
- Highlight missing fields
- Show a clear friendly message

Avoid using a modal unless it clearly improves the experience.

Use modals only for:
- Final confirmation
- Important blocking errors
- Destructive actions
- Cases where inline guidance would be confusing

## Hebrew and RTL

The site may use Hebrew and RTL layout.

Always check:

- Text alignment
- Button alignment
- Product card layout
- Form fields
- Icons direction
- Spacing
- Mobile layout
- Order summary direction

Do not assume LTR layout.

## Code Rules

- Reuse existing components before creating new ones.
- Do not introduce a new UI library without approval.
- Do not rewrite large parts of the app unless explicitly asked.
- Preserve existing business logic.
- Keep changes focused.
- Keep styling consistent with the current project.
- Avoid duplicate styling logic.
- Avoid unnecessary abstractions.
- Make sure the app remains responsive.
- All code changes must be made only on the `dev` branch.

## Before Making UI Changes

Before implementing a design change, first explain:

1. What UX problem you found
2. Why it matters
3. What design solution you propose
4. Which files/components you plan to change
5. What risks exist
6. How you will verify the result

Do not immediately change code for large UI changes before giving a short plan.

## After Making UI Changes

After implementation, verify:

- Mobile layout
- Desktop layout
- Hebrew RTL layout
- Product cards
- Quantity controls
- Checkout flow
- Form validation
- No horizontal overflow
- No broken spacing
- No broken business logic

## Design Decision Rule

When choosing between a prettier design and a clearer ordering flow, choose the clearer ordering flow.

Good design here means:
- Customers understand faster
- Customers trust the business more
- Customers complete orders with less friction
- The website feels fresh and premium without becoming complicated

## Preferred Behavior

When asked to improve the design, do not just “make it nicer”.

Act like a senior ecommerce product designer.

Focus on:
- Conversion
- Clarity
- Trust
- Mobile usability
- Premium grocery feeling
- RTL correctness
- Simple order completion

## Branch Rule

Before changing code, verify that the current branch is `dev`.

If not on `dev`, stop and ask before making changes.

Never commit or push directly to `main`.