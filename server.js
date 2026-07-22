import express from "express";
import cors from "cors";
import crypto from "crypto";
import Razorpay from "razorpay";
import { priceCartItems, createWooOrder } from "./woocommerce.js";
import { validateCoupon } from "./coupons.js";

const PORT = process.env.PORT || 3001;
const COD_FEE = Number(process.env.COD_FEE || 36);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// In-memory cache of server-computed quotes, keyed by Razorpay order id, so
// the payment-verification step never has to trust client-submitted prices —
// it just looks up what we already priced a few seconds earlier. This is
// fine for a single-instance Node process; if the process restarts between
// payment creation and verification (rare — that window is usually seconds),
// verify-payment falls back to re-pricing from the cart it's given.
const quoteCache = new Map();

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
    const total = Math.max(priced.subtotal - (coupon.valid ? coupon.discount : 0), 0);

    if (total <= 0) return res.status(400).json({ error: "Invalid order total" });

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(total * 100), // paise
      currency: "INR",
      receipt: `sba_${Date.now()}`,
    });

    quoteCache.set(razorpayOrder.id, { priced, coupon, total });

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
      quote = { priced, coupon: { valid: false, discount: 0 } };
    }
    quoteCache.delete(razorpay_order_id);

    const order = await createWooOrder({
      pricedItems: quote.priced,
      customer,
      paymentMethod: "razorpay",
      paymentTitle: "Razorpay (UPI/Card)",
      setPaid: true,
      status: "processing",
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
    const total = Math.max(priced.subtotal - (coupon.valid ? coupon.discount : 0), 0) + COD_FEE;

    const order = await createWooOrder({
      pricedItems: priced,
      customer,
      paymentMethod: "cod",
      paymentTitle: "Cash on Delivery",
      setPaid: false,
      status: "processing",
      metaData: [{ key: "cod_fee", value: String(COD_FEE) }],
    });

    res.json({ success: true, orderId: order.id, orderNumber: order.number, total });
  } catch (err) {
    console.error("cod-order error:", err.message);
    res.status(500).json({ error: "Could not place your order. Please try again." });
  }
});

app.listen(PORT, () => console.log(`SB Ayurveda bridge server listening on :${PORT}`));
