# N1 STORE

Digital products store with Apple Pay + card checkout (via Stripe) and a staff dashboard.
No dependencies. Needs Node 18 or newer.

## Run it
    ADMIN_PASSWORD=your-password node server.js
Open http://localhost:3000 (store) and http://localhost:3000/dashboard (staff).

Without a Stripe key the store runs in **demo mode**: orders are recorded as paid but nobody is charged.

## Take real payments (Apple Pay + cards)
1. Create a Stripe account and copy your secret key (Developers > API keys).
2. In Stripe > Settings > Payment methods, make sure **Cards** and **Apple Pay** are on.
3. Set `STRIPE_SECRET_KEY`, `BASE_URL` (your https domain) and `CURRENCY` (aed, usd...).
4. Optional but recommended: add a webhook endpoint `https://your-domain.com/api/webhook` for the event
   `checkout.session.completed` and set `STRIPE_WEBHOOK_SECRET`.
The customer pays on Stripe's secure page, where Apple Pay shows on supported Apple devices.
Card numbers never reach your server.

## Staff dashboard (/dashboard)
Income, paid orders, customers, best sellers, a 14-day income chart, add / delete products (with image),
and mark orders delivered. Sign in with `ADMIN_PASSWORD`.

## Deploy
Any host that runs Node (Render, Railway, Fly.io, a VPS). Start command: `node server.js`.
Use a persistent disk for the `data/` folder (it holds `db.json` with products and orders) and serve over https.

## Files
- server.js — API, Stripe, staff login, static files
- public/ — storefront (index.html), dashboard.html, success.html, style.css, logo
- data/db.json — created on first run
