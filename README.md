# SB Ayurveda checkout bridge server

Small Node/Express server that does the two things a public React app can't
safely do itself: hold secret API keys, and be the trusted source of truth
for order prices. It creates real Razorpay payments and real WooCommerce
orders.

## Endpoints
- `POST /api/create-payment` — prices the cart from live WooCommerce data, creates a Razorpay order
- `POST /api/verify-payment` — verifies a completed Razorpay payment, creates the real WooCommerce order
- `POST /api/cod-order` — creates a Cash on Delivery WooCommerce order directly (no Razorpay)
- `GET /api/health` — check the server is running

## Deploy on Hostinger (Business Web Hosting)

1. In hPanel: **Websites → Add website → Node.js Web App**
2. Upload this folder's contents (or connect the GitHub repo if you push this there)
3. Set the app's entry point to `server.js`
4. In the app's **Environment variables** panel, add every value from `.env.example`:
   - `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — from Razorpay Dashboard → Settings → API Keys (start with **test mode** keys)
   - `WC_CONSUMER_KEY` / `WC_CONSUMER_SECRET` — from wp-admin → WooCommerce → Settings → Advanced → REST API → Add key (permissions: **Read/Write**)
   - `WC_BASE_URL` — `https://sbayurveda.com`
   - `ALLOWED_ORIGINS` — `https://new.sbayurveda.com` (add your final production domain here too once you cut over)
   - `COD_FEE` — `36` (must match the frontend)
5. Start the app. Hostinger will give it a URL (or you can map a subdomain like `api.sbayurveda.com` to it)
6. Tell me that URL — I'll point the React checkout at it

## Testing before going live
Razorpay test-mode keys let you complete full fake payments (card `4111 1111 1111 1111`, any future expiry/CVV) — nothing is actually charged, but every other step is real: a real order will appear in your wp-admin Orders list, and WooCommerce's own order-confirmation email will fire. Do this a few times before switching to live keys.

## Switching to live keys
Once you're confident, replace `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` with your live-mode keys (same Razorpay dashboard, toggle Test/Live) and restart the app. That's the only change needed to start accepting real payments.
