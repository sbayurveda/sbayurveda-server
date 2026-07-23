import express from "express";
import cors from "cors";
import crypto from "crypto";
import Razorpay from "razorpay";
import nodemailer from "nodemailer";
import { priceCartItems, createWooOrder, getWooOrder } from "./woocommerce.js";
import { validateCoupon } from "./coupons.js";

const PORT = process.env.PORT || 3001;
const COD_FEE = Number(process.env.COD_FEE || 36);
const SHIPPING_FEE = Number(process.env.SHIPPING_FEE || 54);
const FREE_SHIPPING_THRESHOLD = Number(process.env.FREE_SHIPPING_THRESHOLD || 799);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Only wired up once SMTP_USER/SMTP_PASS are set (a Gmail address + App
// Password) — until then, /api/notify responds with a clear error instead of
// silently failing, so the frontend can tell the customer something's off.
const mailer =
  process.env.SMTP_USER && process.env.SMTP_PASS
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      })
    : null;
const NOTIFY_TO = process.env.NOTIFY_TO || process.env.SMTP_USER;

// In-memory cache of server-computed quotes, keyed by Razorpay order id, so
// the payment-verification step never has to trust client-submitted prices —
// it just looks up what we already priced a few seconds earlier. This is
// fine for a single-instance Node process; if the process restarts between
// payment creation and verification (rare — that window is usually seconds),
// verify-payment falls back to re-pricing from the cart it's given.
const quoteCache = new Map();

function computeShippingFee(subtotalAfterDiscount) {
  return subtotalAfterDiscount >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
}

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
      else cb(new Error("Not allowed by CORS"));
    },
  })
);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Step 1 (online payment): price the cart from live WooCommerce data, apply
// any coupon, create a Razorpay order for the trusted total, cache the quote.
app.post("/api/create-payment", async (req, res) => {
  try {
    const { items, couponCode } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const priced = await priceCartItems(items);
    const coupon = couponCode ? validateCoupon(couponCode, priced.subtotal) : { valid: false, discount: 0 };
    const discounted = Math.max(priced.subtotal - (coupon.valid ? coupon.discount : 0), 0);
    const shippingFee = computeShippingFee(discounted);
    const total = discounted + shippingFee;

    if (total <= 0) return res.status(400).json({ error: "Invalid order total" });

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(total * 100), // paise
      currency: "INR",
      receipt: `sba_${Date.now()}`,
    });

    quoteCache.set(razorpayOrder.id, { priced, coupon, shippingFee, total });

    res.json({
      razorpayOrderId: razorpayOrder.id,
      amount: total,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("create-payment error:", err.message);
    res.status(500).json({ error: "Could not start payment. Please try again." });
  }
});

// Step 2 (online payment): verify Razorpay's signature, then create the real
// WooCommerce order using the cached, trusted quote (never the client's).
app.post("/api/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, customer, items } = req.body;

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed" });
    }

    let quote = quoteCache.get(razorpay_order_id);
    if (!quote) {
      // Process restarted between create and verify — re-price as a fallback.
      // Razorpay has already confirmed the charge succeeded for its own
      // recorded amount, so this only affects what appears in the WooCommerce
      // order line items, not what was actually charged.
      const priced = await priceCartItems(items || []);
      const discounted = priced.subtotal;
      quote = { priced, coupon: { valid: false, discount: 0 }, shippingFee: computeShippingFee(discounted) };
    }
    quoteCache.delete(razorpay_order_id);

    const order = await createWooOrder({
      pricedItems: quote.priced,
      customer,
      paymentMethod: "razorpay",
      paymentTitle: "Razorpay (UPI/Card)",
      setPaid: true,
      status: "processing",
      shippingFee: quote.shippingFee,
      metaData: [
        { key: "razorpay_order_id", value: razorpay_order_id },
        { key: "razorpay_payment_id", value: razorpay_payment_id },
      ],
    });

    res.json({ success: true, orderId: order.id, orderNumber: order.number, total: order.total });
  } catch (err) {
    console.error("verify-payment error:", err.message);
    res.status(500).json({ error: "Payment succeeded but we couldn't record your order. Please contact us with your payment ID." });
  }
});

// Cash on Delivery: no Razorpay involved, but still price from live data —
// never trust a client-submitted total for the amount collected on delivery.
app.post("/api/cod-order", async (req, res) => {
  try {
    const { items, customer, couponCode } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const priced = await priceCartItems(items);
    const coupon = couponCode ? validateCoupon(couponCode, priced.subtotal) : { valid: false, discount: 0 };
    const discounted = Math.max(priced.subtotal - (coupon.valid ? coupon.discount : 0), 0);
    const shippingFee = computeShippingFee(discounted);
    const total = discounted + shippingFee + COD_FEE;

    const order = await createWooOrder({
      pricedItems: priced,
      customer,
      paymentMethod: "cod",
      paymentTitle: "Cash on Delivery",
      setPaid: false,
      status: "processing",
      shippingFee,
      codFee: COD_FEE,
      metaData: [{ key: "cod_fee", value: String(COD_FEE) }],
    });

    res.json({ success: true, orderId: order.id, orderNumber: order.number, total: order.total });
  } catch (err) {
    console.error("cod-order error:", err.message);
    res.status(500).json({ error: "Could not place your order. Please try again." });
  }
});

function normalizePhone(v) {
  return String(v || "").replace(/\D/g, "").slice(-10);
}
function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

// Real, current order status — lets the storefront's "My Orders" reflect
// whatever's actually true in WooCommerce (e.g. an order you marked
// Completed or Cancelled from wp-admin), instead of freezing at whatever
// status it had at checkout time.
//
// WooCommerce order IDs are small sequential numbers, so this endpoint must
// never return full order details (name, phone, address) on ID alone — that
// would let anyone enumerate every order ever placed. The caller has to also
// supply the phone or email used on that order; only requests to your own
// storefront pass one automatically (it's stored with the order locally), a
// guest looking their own order up types it in manually.
app.get("/api/order/:id", async (req, res) => {
  try {
    const order = await getWooOrder(req.params.id);
    const contact = req.query.contact;
    const matches =
      contact &&
      (normalizeEmail(contact) === normalizeEmail(order.billing?.email) ||
        (normalizePhone(contact).length === 10 && normalizePhone(contact) === normalizePhone(order.billing?.phone)));

    if (!matches) {
      // Same message as "doesn't exist" — never confirm an order ID is real
      // to a request that hasn't proven it owns it.
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error("get-order error:", err.message);
    res.status(404).json({ error: "Order not found" });
  }
});

// Prescription uploads and doctor-appointment requests email the store
// directly instead of relying on the customer's own WhatsApp opening.
app.post("/api/notify", async (req, res) => {
  try {
    if (!mailer) {
      return res.status(503).json({ error: "Email isn't configured on the server yet." });
    }
    const { subject, lines } = req.body;
    if (!subject || !Array.isArray(lines)) {
      return res.status(400).json({ error: "Missing subject or details" });
    }

    const html = `<div style="font-family:sans-serif;font-size:14px;color:#1C231E;">
      <h2 style="margin:0 0 12px;">${subject}</h2>
      <table cellpadding="6" style="border-collapse:collapse;">
        ${lines
          .map(
            ([label, value]) =>
              `<tr><td style="color:#666;vertical-align:top;">${label}</td><td><strong>${value || "—"}</strong></td></tr>`
          )
          .join("")}
      </table>
    </div>`;

    await mailer.sendMail({
      from: `"SB Ayurveda Website" <${process.env.SMTP_USER}>`,
      to: NOTIFY_TO,
      subject: `[SB Ayurveda] ${subject}`,
      html,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("notify error:", err.message);
    res.status(500).json({ error: "Could not send this right now. Please try WhatsApp instead." });
  }
});

app.listen(PORT, () => console.log(`SB Ayurveda bridge server listening on :${PORT}`));
