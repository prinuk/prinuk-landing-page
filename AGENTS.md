# AGENTS.md – Codex Project Instructions

## Project Overview

This project is an online ordering website for fruits and vegetables.

The main goal is to make the ordering process simple, clear, fast, and mobile-friendly.

The website should feel:
- Premium
- Fresh
- Clean
- Trustworthy
- Easy to use

Do not introduce changes that make the ordering flow longer, more confusing, or harder for customers to complete.

---

## Critical Git Rules

All changes must be made only on the `dev` branch.

Before making any code change, verify the current branch:

```bash
git branch --show-current
```

If the current branch is not `dev`, switch to `dev`:

```bash
git checkout dev
git pull origin dev
```

Never commit or push directly to:
- `main`
- `master`
- `production`
- Any branch other than `dev`

Before committing or pushing, always check:

```bash
git status
git diff
```

When the change is complete:

```bash
git add .
git commit -m "Clear description of the change"
git push origin dev
```

If the repository is not on `dev`, stop and do not make changes until switching to `dev`.

---

## Product Goal

A customer should understand how to place an order within a few seconds and complete the order without confusion.

This is the highest priority of the project.

---

## User Experience Priorities

The ordering flow must be simple and obvious.

Recommended flow:

1. Select a category: fruits, vegetables, or additional products
2. Select products
3. Choose quantities
4. Review the cart
5. Enter customer details
6. Confirm the order
7. Show a clear success message

Avoid:
- Long checkout flows
- Unnecessary screens
- Complicated forms
- Hidden prices
- Unclear buttons
- Technical wording
- Any interaction that makes ordering harder

At every step, the customer should clearly understand:
- What they selected
- The current quantity
- The current price
- The order total
- What the next step is
- How to edit or remove items

---

## Mobile First

Most customers are expected to use the website from a phone.

Always prioritize mobile usability:
- Large tap targets
- Readable text
- Clear spacing
- Simple product cards
- Easy quantity controls
- A cart that is easy to find
- A checkout button that is easy to see
- No visual clutter on small screens

The desktop version should also look polished, but mobile comes first.

---

## Design Direction

The visual design should feel premium, fresh, clean, and modern.

Recommended style:
- Light, clean background
- Natural fresh colors
- Subtle greens, whites, cream tones, and fruit-inspired accent colors
- Generous spacing
- Rounded corners
- Clean product cards
- High-quality product images
- Clear typography
- Soft shadows only when useful
- Calm, elegant layout

Avoid:
- Too many strong colors
- Cheap-looking banners
- Heavy animations
- Visual clutter
- Overloaded sections
- Aggressive marketing style
- Hiding important actions or prices

The design should feel like a high-quality fresh produce store, not a generic marketplace.

---

## Language and Direction

The customer-facing website must be in Hebrew.

Requirements:
- Full RTL support
- Hebrew labels
- Hebrew buttons
- Hebrew validation messages
- Hebrew success and error messages
- Friendly, simple, non-technical wording

Do not leave English text in the customer-facing UI unless explicitly required.

Internal code, file names, component names, and comments may be in English.

---

## Suggested Hebrew UI Text

Use clear and friendly Hebrew text.

Good examples:
- “הוסף להזמנה”
- “המשך להזמנה”
- “סיכום הזמנה”
- “שלח הזמנה”
- “ההזמנה התקבלה בהצלחה”
- “נחזור אליכם בהקדם”
- “בחרו כמות לפני ההמשך”
- “נשמח לדעת לאן לשלוח את ההזמנה”
- “משהו השתבש בשליחת ההזמנה. אפשר לנסות שוב בעוד רגע.”

Avoid technical error messages in the UI.

---

## Product Cards

Each product card should clearly show:
- Product name
- Product image, if available
- Price
- Unit type, such as kg, unit, package, basket, bundle, etc.
- Quantity selector
- Add/remove behavior
- Clear indication when the product is already in the cart

Quantity controls should be simple:
- Plus button
- Minus button
- Current quantity display
- Prevent negative quantities
- Remove item from cart when quantity becomes zero

---

## Cart Requirements

The cart should be easy to access and understand.

The cart should show:
- Selected products
- Quantity per product
- Price per product
- Order total
- Option to edit quantities
- Option to remove products
- Clear checkout button

The cart should never feel hidden or disconnected from the product selection flow.

On mobile, make sure the cart or checkout action is easy to find.

---

## Checkout Form

Keep the checkout form short.

Recommended fields:
- Full name
- Phone number
- Delivery address
- Order notes

Do not add unnecessary fields.

Validation rules:
- Full name is required
- Phone number is required and should look valid
- Delivery address is required

Validation messages must be in Hebrew and easy to understand.

Do not clear the customer's cart or form data if an error occurs.

---

## Order Submission

When handling an order, keep the order data structured and readable.

An order should include:
- Customer name
- Customer phone number
- Delivery address
- Order notes, if provided
- List of products
- Quantity per product
- Unit price if available
- Total price if available

If the order is sent to WhatsApp, email, Google Sheets, or a backend API, the format should be clear and easy for the business owner to read.

Example order format:

```text
New order

Name: Israel Israeli
Phone: 050-0000000
Address: Example Street 10, Jerusalem

Products:
- Tomatoes | 2 kg | ₪20
- Apples | 1 kg | ₪12

Total: ₪32

Notes:
Leave next to the door
```

Customer-facing messages should still be in Hebrew.

---

## Error Handling

When something fails:
- Do not show technical errors to the customer
- Show a simple Hebrew error message
- Preserve the cart and form data
- Allow the customer to try again
- Log only non-sensitive technical details if needed

Good customer-facing example:
“משהו השתבש בשליחת ההזמנה. אפשר לנסות שוב בעוד רגע.”

---

## Accessibility

Maintain good accessibility:
- Good contrast between text and background
- Buttons large enough for touch
- Descriptive alt text for images
- Keyboard-friendly interactions where relevant
- Clear focus states
- Semantic HTML when possible
- No text that is too small to read on mobile

---

## Performance

Keep the website fast.

Guidelines:
- Avoid unnecessary heavy dependencies
- Optimize images when possible
- Avoid layout shift
- Avoid expensive client-side logic
- Keep animations lightweight
- Do not block the main ordering flow with slow features

---

## Code Quality

Write simple, readable, maintainable code.

Guidelines:
- Use clear variable and function names
- Keep components focused
- Avoid duplicated logic
- Separate UI, state, and data logic where practical
- Follow the existing project structure
- Prefer small, targeted changes
- Do not introduce large refactors unless explicitly needed
- Do not remove existing behavior without understanding its usage
- Do not add large dependencies without a clear reason

Before changing code, first understand:
- The existing project structure
- Existing components
- Existing styling conventions
- Existing state management
- Existing API or order handling flow
- Existing build and test scripts

---

## Testing and Checks

After making changes, run relevant checks if they exist:

```bash
npm run lint
npm run build
npm test
```

If a command does not exist, mention it in the final summary.

Do not invent new scripts unless the task specifically requires it.

If a check fails, explain:
- Which command failed
- What the error was
- Whether the failure is related to the change

---

## Security and Privacy

Never commit:
- API keys
- Tokens
- Secrets
- Private customer data
- `.env` files
- Credentials

Use environment variables for sensitive configuration.

Do not print sensitive customer information in logs unless absolutely necessary for local debugging, and never in production logs.

---

## Data Handling

Customer order data should be handled carefully.

Do not expose customer details unnecessarily.

Do not store private data in the frontend unless required for the ordering flow.

Do not send customer data to third-party services unless this is already part of the project requirements.

---

## SEO and Sharing

When relevant, keep basic SEO and sharing in mind:
- Clear page title
- Clear meta description
- Proper Hebrew content
- Good preview title for WhatsApp and social sharing
- Relevant preview image if the project supports it

Do not prioritize SEO over the ordering experience.

---

## Do Not Do

Do not:
- Push to `main`, `master`, or `production`
- Break RTL layout
- Leave English text in customer-facing UI
- Make the checkout flow longer without a strong reason
- Add unnecessary dependencies
- Hide prices or totals
- Remove existing features without checking their usage
- Commit secrets or `.env` files
- Show technical errors to customers
- Make broad refactors when a small change is enough

---

## Codex Work Process

For every task:

1. Inspect the current project structure.
2. Make sure the active branch is `dev`.
3. Understand the existing implementation before changing it.
4. Make the smallest useful change.
5. Preserve Hebrew RTL customer-facing UI.
6. Preserve or improve the simple ordering flow.
7. Preserve the premium and fresh design direction.
8. Run available checks.
9. Summarize the work clearly.

---

## Final Response Format

After each task, respond with this format:

```text
Done:
- ...

Changed files:
- ...

Checks:
- npm run lint: passed / failed / not available
- npm run build: passed / failed / not available
- npm test: passed / failed / not available

Notes:
- ...
```

If no files were changed, say so clearly.

If checks were not run, explain why.

---

## Highest Priority

A customer should understand how to place an order within a few seconds and complete the order without confusion.

Every design, code, and UX decision should support this goal.
