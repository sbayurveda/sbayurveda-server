import express from "express";
import cors from "cors";
import crypto from "crypto";
import Razorpay from "razorpay";
import nodemailer from "nodemailer";
import {
  priceCartItems,
  createWooOrder,
  getWooOrder,
  listWooOrders,
  getWooOrderNotes,
} from "./woocommerce.js";
import { validateCoupon } from "./coupons.js";

// Cart items come straight from the browser and drive a WooCommerce API call
// per item — an unbounded array is both a request-forgery and a resource-
// exhaustion vector (hammer our own server's downstream WooCommerce calls).
// No real cart on this store gets remotely close to this size.
const MAX_CART_ITEMS = 50;

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

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

// A deliberately dependency-free rate limiter. An earlier attempt at this used
// express-rate-limit and took payments offline for days: the package was never
// installed in the runtime's node_modules, so the import crashed the process on
// its next restart. Fixed-window counting in a plain Map is all this
// single-instance server needs, and it can never fail to resolve at import.
function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || "unknown";
    const entry = hits.get(key);

    if (!entry || now - entry.startedAt > windowMs) {
      hits.set(key, { startedAt: now, count: 1 });
      // Opportunistic sweep — without it the Map grows once per unique IP and
      // never shrinks, which is a slow memory leak on a long-lived process.
      if (hits.size > 5000) {
        for (const [k, v] of hits) {
          if (now - v.startedAt > windowMs) hits.delete(k);
        }
      }
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      res.setHeader("Retry-After", Math.ceil((entry.startedAt + windowMs - now) / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const FIFTEEN_MIN = 15 * 60 * 1000;

// Order lookup requires a matching contact, but without a limit an attacker who
// knows one phone number could still script through order ids looking for it.
const orderLookupLimiter = createRateLimiter({
  windowMs: FIFTEEN_MIN,
  max: 60,
  message: "Too many lookups. Please wait a few minutes and try again.",
});
// /api/notify sends real email with attacker-controlled content — keep it well
// below anything a genuine customer would ever reach.
const notifyLimiter = createRateLimiter({
  windowMs: FIFTEEN_MIN,
  max: 10,
  message: "Too many requests. Please wait a few minutes and try again.",
});
const orderCreationLimiter = createRateLimiter({
  windowMs: FIFTEEN_MIN,
  max: 40,
  message: "Too many attempts. Please wait a few minutes and try again.",
});

// ---------------------------------------------------------------------------
// Admin dashboard auth
//
// The admin order history exposes every customer's name, phone, email and
// address, so the gate has to live here on the server — a frontend-only check
// would leave the underlying endpoint open to anyone who found its URL. Both
// values come from the environment; if either is missing the admin routes stay
// switched off rather than falling back to a guessable default.
// ---------------------------------------------------------------------------
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || "";
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const adminConfigured = Boolean(ADMIN_PASSWORD && ADMIN_TOKEN_SECRET);

// Sessions are a signed expiry stamp rather than a stored id, so a restart
// doesn't sign everyone out and there's no session table to keep.
function signAdminToken(expiresAt) {
  const payload = String(expiresAt);
  const sig = crypto.createHmac("sha256", ADMIN_TOKEN_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyAdminToken(token) {
  if (!adminConfigured || typeof token !== "string") return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = crypto.createHmac("sha256", ADMIN_TOKEN_SECRET).update(payload).digest("hex");
  if (!timingSafeEqualStr(sig, expected)) return false;
  return Number(payload) > Date.now();
}

const adminLoginLimiter = createRateLimiter({
  windowMs: FIFTEEN_MIN,
  max: 8,
  message: "Too many sign-in attempts. Please wait 15 minutes and try again.",
});
const adminDataLimiter = createRateLimiter({
  windowMs: FIFTEEN_MIN,
  max: 600,
  message: "Too many requests. Please slow down.",
});

function requireAdmin(req, res, next) {
  if (!adminConfigured) {
    return res.status(503).json({ error: "Admin access is not configured on this server." });
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!verifyAdminToken(token)) {
    return res.status(401).json({ error: "Session expired. Please sign in again." });
  }
  // Customer PII must never sit in the CDN or a browser disk cache.
  res.setHeader("Cache-Control", "no-store, private");
  next();
}

const app = express();
// Hostinger terminates TLS and proxies to this app, so every request would
// otherwise appear to come from the proxy's own IP — trust exactly one hop
// of X-Forwarded-For so rate limiting (and req.ip generally) sees the real
// client IP instead of rate-limiting all customers as a single "user".
app.set("trust proxy", 1);
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

// --- Admin order history -----------------------------------------------------

app.post("/api/admin/login", adminLoginLimiter, (req, res) => {
  if (!adminConfigured) {
    return res.status(503).json({ error: "Admin access is not configured on this server." });
  }
  const { username, password } = req.body || {};
  const userOk = timingSafeEqualStr(username, ADMIN_USER);
  const passOk = timingSafeEqualStr(password, ADMIN_PASSWORD);
  // Check both before answering so the response doesn't reveal which half was
  // wrong, and answer identically either way.
  if (!userOk || !passOk) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  const expiresAt = Date.now() + ADMIN_SESSION_MS;
  res.setHeader("Cache-Control", "no-store, private");
  res.json({ token: signAdminToken(expiresAt), expiresAt });
});

app.get("/api/admin/orders", adminDataLimiter, requireAdmin, async (req, res) => {
  try {
    const { page, perPage, after, before, status, search } = req.query;
    const result = await listWooOrders({
      page: Number(page) || 1,
      perPage: Number(perPage) || 50,
      after,
      before,
      status,
      search,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("admin-orders error:", err.message);
    res.status(502).json({ error: "Could not load orders from WooCommerce." });
  }
});

app.get("/api/admin/orders/:id/notes", adminDataLimiter, requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, notes: await getWooOrderNotes(req.params.id) });
  } catch (err) {
    console.error("admin-order-notes error:", err.message);
    res.status(502).json({ error: "Could not load order notes." });
  }
});

// Step 1 (online payment): price the cart from live WooCommerce data, apply
// any coupon, create a Razorpay order for the trusted total, cache the quote.
app.post("/api/create-payment", orderCreationLimiter, async (req, res) => {
  try {
    const { items, couponCode } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }
    if (items.length > MAX_CART_ITEMS) {
      return res.status(400).json({ error: "Too many items in cart" });
    }

    let priced;
    try {
      priced = await priceCartItems(items);
    } catch (priceErr) {
      // Product-availability errors (out of stock, no longer purchasable) are
      // safe and useful to show the customer directly — unlike the generic
      // 500 below, this tells them exactly what to remove from their cart.
      return res.status(400).json({ error: priceErr.message });
    }
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
app.post("/api/verify-payment", orderCreationLimiter, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, customer, items, couponCode } = req.body;

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    // Constant-time comparison — a plain !== leaks timing information that
    // could theoretically help an attacker forge a valid signature byte by
    // byte. Guard the length check too, since timingSafeEqual throws (rather
    // than just returning false) if the buffers differ in size.
    const signatureValid =
      typeof razorpay_signature === "string" &&
      razorpay_signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature));

    if (!signatureValid) {
      return res.status(400).json({ error: "Payment verification failed" });
    }

    if (Array.isArray(items) && items.length > MAX_CART_ITEMS) {
      return res.status(400).json({ error: "Too many items in cart" });
    }

    let quote = quoteCache.get(razorpay_order_id);
    if (!quote) {
      // Process restarted between create and verify — re-price as a fallback.
      // Razorpay has already confirmed the charge succeeded for its own
      // recorded amount, so we must reconstruct the SAME coupon/shipping the
      // customer was actually charged for, not just the raw product prices —
      // otherwise the WooCommerce order would overstate the total (this was a
      // real bug: a lost cache entry silently dropped an applied coupon,
      // recording orders at full price while the customer was charged less).
      const priced = await priceCartItems(items || []);
      const coupon = couponCode ? validateCoupon(couponCode, priced.subtotal) : { valid: false, discount: 0 };
      const discounted = Math.max(priced.subtotal - (coupon.valid ? coupon.discount : 0), 0);
      quote = { priced, coupon, shippingFee: computeShippingFee(discounted) };
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
      coupon: quote.coupon,
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
app.post("/api/cod-order", orderCreationLimiter, async (req, res) => {
  try {
    const { items, customer, couponCode } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }
    if (items.length > MAX_CART_ITEMS) {
      return res.status(400).json({ error: "Too many items in cart" });
    }

    let priced;
    try {
      priced = await priceCartItems(items);
    } catch (priceErr) {
      return res.status(400).json({ error: priceErr.message });
    }
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
      coupon,
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
app.get("/api/order/:id", orderLookupLimiter, async (req, res) => {
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
app.post("/api/notify", notifyLimiter, async (req, res) => {
  try {
    if (!mailer) {
      return res.status(503).json({ error: "Email isn't configured on the server yet." });
    }
    const { subject, lines } = req.body;
    if (!subject || !Array.isArray(lines)) {
      return res.status(400).json({ error: "Missing subject or details" });
    }
    if (String(subject).length > 200 || lines.length > 30) {
      return res.status(400).json({ error: "Request too large" });
    }

    // Strip line breaks from the subject (defends against header injection
    // in the raw "subject:" header) and HTML-escape everything going into
    // the email body — subject/lines are attacker-controlled input.
    const safeSubject = String(subject).replace(/[\r\n]/g, " ").trim();

    const html = `<div style="font-family:sans-serif;font-size:14px;color:#1C231E;">
      <h2 style="margin:0 0 12px;">${escapeHtml(safeSubject)}</h2>
      <table cellpadding="6" style="border-collapse:collapse;">
        ${lines
          .map(
            ([label, value]) =>
              `<tr><td style="color:#666;vertical-align:top;">${escapeHtml(label)}</td><td><strong>${escapeHtml(value) || "—"}</strong></td></tr>`
          )
          .join("")}
      </table>
    </div>`;

    await mailer.sendMail({
      from: `"SB Ayurveda Website" <${process.env.SMTP_USER}>`,
      to: NOTIFY_TO,
      subject: `[SB Ayurveda] ${safeSubject}`,
      html,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("notify error:", err.message);
    res.status(500).json({ error: "Could not send this right now. Please try WhatsApp instead." });
  }
});

app.listen(PORT, () => console.log(`SB Ayurveda bridge server listening on :${PORT}`));
