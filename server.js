import express from "express";
import cors from "cors";
import crypto from "crypto";
import Razorpay from "razorpay";
import {
  priceCartItems,
  createWooOrder,
  getWooOrder,
  listWooOrders,
  getWooOrderNotes,
  updateWooOrder,
  addWooOrderNote,
  fetchOrdersInRange,
  ALLOWED_ORDER_STATUSES,
} from "./woocommerce.js";
import { computeAnalytics } from "./analytics.js";
import {
  startStore, storeStatus, syncAll, allProducts, allOrders, upsertProduct, upsertOrder,
} from "./store.js";
import { buildCustomers, customerSummary, codRisks } from "./customers.js";
import { buildMtr } from "./mtr.js";
import { activeBanners, listBanners, saveBanners } from "./banners.js";
import {
  codRules, saveCodRules, blockPhone, unblockPhone, codAvailability, isPhoneBlocked,
} from "./codRules.js";
import {
  createWooProduct,
  updateWooProduct,
  uploadProductImage,
  listProductsNeedingWork,
  listTaxonomy,
  setCodForProducts,
  mediaUploadConfigured,
  cleanupMedia,
  mediaPathFor,
  MAX_IMAGE_BYTES,
} from "./products.js";
import fs from "fs";
import { findOrphanedPayments, summariseReconciliation } from "./reconcile.js";
import { validateCoupon } from "./coupons.js";
import {
  savePending,
  readRecord,
  markCompleted,
  getCompletedOrder,
  cleanupOld,
  pendingDir,
} from "./pendingOrders.js";

// Cart items come straight from the browser. Pricing now batches them into a
// single WooCommerce call, but an unbounded array is still a resource-
// exhaustion vector — and the Store API itself caps a collection at 100.
// No real cart on this store gets remotely close to this size.
const MAX_CART_ITEMS = 50;

const PORT = process.env.PORT || 3001;
const COD_FEE = Number(process.env.COD_FEE || 36);
// Cash on Delivery is offered only between these two order values: above the
// ceiling a refusal costs most, below the floor the handling costs more than
// the order is worth. The checkout hides the option outside the band, but that
// is a hint to a browser we don't control — this is the check that holds.
const COD_MIN_ORDER_VALUE = Number(process.env.COD_MIN_ORDER_VALUE || 300);
const COD_MAX_ORDER_VALUE = Number(process.env.COD_MAX_ORDER_VALUE || 2200);
const SHIPPING_FEE = Number(process.env.SHIPPING_FEE || 54);
const FREE_SHIPPING_THRESHOLD = Number(process.env.FREE_SHIPPING_THRESHOLD || 799);
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

// Razorpay order id -> the WooCommerce order we already created for it.
//
// verify-payment can legitimately arrive more than once for a single payment:
// an impatient double-click, a network retry, or the browser replaying the
// request. Without this, each arrival created another WooCommerce order, so one
// payment could show up as two or three orders. Answering the repeat call with
// the order we made the first time keeps it to exactly one.
const completedPayments = new Map();
// Orders currently being created, so concurrent retries can await the first
// attempt rather than starting their own.
const inFlightPayments = new Map();
const COMPLETED_PAYMENT_TTL_MS = 24 * 60 * 60 * 1000;

function rememberCompletedPayment(razorpayOrderId, order) {
  completedPayments.set(razorpayOrderId, { order, at: Date.now() });
  if (completedPayments.size > 2000) {
    const cutoff = Date.now() - COMPLETED_PAYMENT_TTL_MS;
    for (const [key, value] of completedPayments) {
      if (value.at < cutoff) completedPayments.delete(key);
    }
  }
}

function computeShippingFee(subtotalAfterDiscount) {
  return subtotalAfterDiscount >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
}

// The single place a paid order becomes a WooCommerce order.
//
// Two things can trigger it — the customer's browser returning from Razorpay,
// or Razorpay's webhook — and either may arrive first, twice, or not at all.
// Routing both through here means exactly one order per payment: already-done
// is returned from memory or disk, and a request that arrives while another is
// mid-creation waits for that one instead of racing it.
async function ensureOrderForPayment({ razorpayOrderId, razorpayPaymentId, fallback = {} }) {
  const remembered = completedPayments.get(razorpayOrderId);
  if (remembered) return { order: remembered.order, duplicate: true };

  // Disk survives the restart that a deploy causes mid-payment.
  const persisted = getCompletedOrder(razorpayOrderId);
  if (persisted) {
    rememberCompletedPayment(razorpayOrderId, persisted);
    return { order: persisted, duplicate: true };
  }

  const inFlight = inFlightPayments.get(razorpayOrderId);
  if (inFlight) return { order: await inFlight, duplicate: true };

  const creation = (async () => {
    const record = readRecord(razorpayOrderId);
    const customer = record?.customer || fallback.customer;
    const attribution = record?.attribution || fallback.attribution;

    // Prefer the quote priced when the payment was started — it's what the
    // customer was actually charged.
    let quote = quoteCache.get(razorpayOrderId) || record?.quote;
    if (!quote) {
      // Only reachable for a payment started before this record-keeping
      // existed. Re-price from the cart the browser sent, reapplying the same
      // coupon and shipping so the order can't overstate what was charged.
      if (!Array.isArray(fallback.items) || fallback.items.length === 0) {
        throw new Error("no saved quote and no cart to re-price from");
      }
      const priced = await priceCartItems(fallback.items);
      const coupon = fallback.couponCode
        ? validateCoupon(fallback.couponCode, priced.subtotal)
        : { valid: false, discount: 0 };
      const discounted = Math.max(priced.subtotal - (coupon.valid ? coupon.discount : 0), 0);
      quote = { priced, coupon, shippingFee: computeShippingFee(discounted) };
    }

    // Money has already left the customer's account by the time we get here, so
    // never refuse to record the order. If the delivery details are missing,
    // fall back to the name/email/phone Razorpay holds for the payment, book
    // the order on-hold and flag it, rather than leaving a paid customer with
    // nothing — which is what used to happen.
    let resolved = customer;
    let incomplete = false;
    if (!resolved?.email && !resolved?.phone) {
      incomplete = true;
      let fromGateway = {};
      try {
        const payment = await razorpay.payments.fetch(razorpayPaymentId);
        fromGateway = {
          email: payment?.email || "",
          phone: String(payment?.contact || "").replace(/\D/g, "").slice(-10),
        };
      } catch (err) {
        console.error(`could not read payment ${razorpayPaymentId} from Razorpay: ${err.message}`);
      }
      resolved = {
        name: fromGateway.email ? fromGateway.email.split("@")[0] : "Customer",
        email: fromGateway.email,
        phone: fromGateway.phone,
        flatBuilding: "",
        area: "",
        city: "",
        state: "",
        pincode: "",
      };
    }

    const order = await createWooOrder({
      pricedItems: quote.priced,
      customer: resolved,
      paymentMethod: "razorpay",
      paymentTitle: "Razorpay (UPI/Card)",
      setPaid: true,
      // An order with no address can't be picked, so it waits on-hold for
      // someone to call the customer instead of joining the dispatch queue.
      status: incomplete ? "on-hold" : "processing",
      shippingFee: quote.shippingFee,
      coupon: quote.coupon,
      transactionId: razorpayPaymentId,
      attribution,
      metaData: [
        { key: "razorpay_order_id", value: razorpayOrderId },
        { key: "razorpay_payment_id", value: razorpayPaymentId },
        ...(incomplete ? [{ key: "_sba_needs_review", value: "yes" }] : []),
      ],
    });

    if (incomplete) {
      // Marking an order paid makes WooCommerce run payment_complete(), which
      // moves it to processing and overrides the status asked for at creation.
      // Without this second call an order with no address sits in the dispatch
      // queue looking ready to pick.
      await updateWooOrder(order.id, { status: "on-hold" }).catch((err) =>
        console.error(`could not hold order ${order.id} for review: ${err.message}`)
      );
      order.status = "on-hold";

      // A note is what actually surfaces this to whoever opens the order, in
      // this dashboard or in wp-admin.
      await addWooOrderNote(
        order.id,
        `NEEDS REVIEW — payment ${razorpayPaymentId} succeeded but the delivery address was never received, ` +
        `so this order was rebuilt from the payment record alone. Contact the customer for their address ` +
        `before dispatch, then move the order to Processing.`,
        { customerNote: false }
      ).catch((err) => console.error(`could not add review note to ${order.id}: ${err.message}`));

      console.error(
        `ORDER NEEDS REVIEW: created order ${order.number} from payment ${razorpayPaymentId} without an address`
      );
    }

    return order;
  })();

  inFlightPayments.set(razorpayOrderId, creation);
  try {
    const order = await creation;
    rememberCompletedPayment(razorpayOrderId, order);
    markCompleted(razorpayOrderId, order);
    quoteCache.delete(razorpayOrderId);
    return { order, duplicate: false };
  } finally {
    inFlightPayments.delete(razorpayOrderId);
  }
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
// Writes change real orders, so they get a tighter budget than reads — still
// far above what hand-editing orders in the dashboard could ever reach.
const adminWriteLimiter = createRateLimiter({
  windowMs: FIFTEEN_MIN,
  max: 200,
  message: "Too many changes at once. Please wait a moment and retry.",
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
// Keep the raw bytes around: Razorpay signs the exact body it sent, so the
// webhook signature can only be checked against the unparsed payload.
app.use(
  express.json({
    // Product images arrive as base64 inside JSON rather than as multipart:
    // it needs no parser, and this server gaining a dependency once took
    // payments down for days. base64 inflates by about a third, so the limit
    // is the image cap plus headroom.
    limit: Math.ceil(MAX_IMAGE_BYTES * 1.4),
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
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

// Razorpay tells us server-to-server the moment a payment is captured.
//
// This is what makes an order independent of the customer's phone. A UPI payer
// leaves for GPay/PhonePe and may never return — app closed, screen locked, tab
// dropped by Android — in which case the browser's verify-payment call never
// happens and, before this existed, no order was created and nothing was even
// logged, because nothing reached the server at all.
//
// Whichever arrives first wins and the other becomes a no-op; both go through
// ensureOrderForPayment, so a payment can still only ever produce one order.
app.post("/api/razorpay/webhook", async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not set");
    return res.status(503).json({ error: "Webhook not configured" });
  }

  // Signed over the exact bytes Razorpay sent, so this must use the raw body.
  const signature = req.headers["x-razorpay-signature"];
  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody || Buffer.from(""))
    .digest("hex");
  if (!signature || !timingSafeEqualStr(signature, expected)) {
    // Anyone can reach this URL, so an unsigned call is treated as hostile.
    return res.status(400).json({ error: "Invalid signature" });
  }

  const event = req.body?.event;
  const payment = req.body?.payload?.payment?.entity;

  // Acknowledge anything we don't act on, so Razorpay doesn't keep retrying it.
  if (event !== "payment.captured" || !payment?.order_id) {
    return res.json({ ok: true, ignored: event || "unknown" });
  }

  try {
    const { order, duplicate } = await ensureOrderForPayment({
      razorpayOrderId: payment.order_id,
      razorpayPaymentId: payment.id,
    });
    if (!duplicate) {
      console.log(
        `webhook recovered order ${order.number} for payment ${payment.id} ` +
        `(customer never made it back from their payment app)`
      );
    }
    res.json({ ok: true, orderNumber: order.number, duplicate });
  } catch (err) {
    // Deliberately a 500: Razorpay retries failed webhooks, and a retry is
    // exactly what a paid-but-unrecorded order needs.
    console.error(
      `webhook error: ORDER NOT RECORDED for razorpay_payment_id=${payment.id} ` +
      `razorpay_order_id=${payment.order_id}: ${err.message}`
    );
    res.status(500).json({ error: "Could not record order" });
  }
});

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

// Aggregating a range means paging through every order in it, which is far too
// slow to redo on each panel render. Results are cached briefly and keyed by the
// range, so flipping between 7/30/90 days stays instant.
const analyticsCache = new Map();
const ANALYTICS_TTL_MS = 5 * 60 * 1000;

function isIsoDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

app.get("/api/admin/analytics", adminDataLimiter, requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!isIsoDay(from) || !isIsoDay(to) || from > to) {
      return res.status(400).json({ error: "Invalid date range." });
    }

    // The comparison window is the same number of days ending the day before
    // this one starts, so "vs previous" compares like with like.
    const spanDays = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (spanDays > 400) {
      return res.status(400).json({ error: "Please choose a range of a year or less." });
    }
    const prevTo = new Date(`${from}T00:00:00Z`);
    prevTo.setUTCDate(prevTo.getUTCDate() - 1);
    const prevFrom = new Date(prevTo);
    prevFrom.setUTCDate(prevFrom.getUTCDate() - (spanDays - 1));
    const previousTo = prevTo.toISOString().slice(0, 10);
    const previousFrom = prevFrom.toISOString().slice(0, 10);

    const cacheKey = `${from}:${to}`;
    const hit = analyticsCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ANALYTICS_TTL_MS) {
      return res.json({ success: true, cached: true, ...hit.data });
    }

    // One fetch spanning both windows, then split in memory.
    const orders = await fetchOrdersInRange({
      after: `${previousFrom}T00:00:00`,
      before: `${to}T23:59:59`,
    });
    const data = computeAnalytics(orders, { from, to, previousFrom, previousTo });

    analyticsCache.set(cacheKey, { at: Date.now(), data });
    if (analyticsCache.size > 100) {
      for (const [key, value] of analyticsCache) {
        if (Date.now() - value.at > ANALYTICS_TTL_MS) analyticsCache.delete(key);
      }
    }

    res.json({ success: true, cached: false, ...data });
  } catch (err) {
    console.error("admin-analytics error:", err.message);
    res.status(502).json({ error: "Could not build analytics from WooCommerce." });
  }
});

// Finds captured payments that never became an order, and optionally creates
// them. Reconciliation has to come from Razorpay rather than our own records —
// the whole failure mode is that our side has no trace of the order.
//
// Defaults to a dry run: this creates real orders, so it reports first and only
// acts when explicitly told to.
app.post("/api/admin/recover-payments", adminWriteLimiter, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 60);
    const apply = req.query.apply === "true";

    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 86400;

    const payments = await razorpay.payments.all({ from, to, count: 100 });
    const captured = (payments?.items || []).filter((p) => p.status === "captured");

    // Every order in the window, so we know which payments are already booked.
    const orders = await fetchOrdersInRange({
      after: new Date(from * 1000).toISOString().slice(0, 19),
      before: new Date(to * 1000).toISOString().slice(0, 19),
    });
    const booked = new Set(orders.map((o) => o.razorpayPaymentId).filter(Boolean));

    const orphans = findOrphanedPayments({
      capturedPayments: captured,
      bookedPaymentIds: booked,
      hasSavedCart: (razorpayOrderId) => Boolean(readRecord(razorpayOrderId)?.quote),
    });

    const recovered = [];
    const needsManualEntry = orphans.filter((o) => !o.recoverable);

    for (const orphan of orphans.filter((o) => o.recoverable)) {
      if (!apply) {
        recovered.push({ ...orphan, wouldCreate: true });
        continue;
      }
      try {
        const { order } = await ensureOrderForPayment({
          razorpayOrderId: orphan.razorpayOrderId,
          razorpayPaymentId: orphan.paymentId,
        });
        recovered.push({ ...orphan, orderNumber: order.number });
      } catch (err) {
        needsManualEntry.push({ ...orphan, reason: err.message });
      }
    }

    res.json({
      success: true,
      dryRun: !apply,
      windowDays: days,
      ...summariseReconciliation(captured, orphans),
      recovered,
      needsManualEntry,
    });
  } catch (err) {
    console.error("recover-payments error:", err.message);
    res.status(502).json({ error: "Could not reconcile payments." });
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

// Only http(s) links are accepted — a courier tracking field that accepted
// javascript: or data: URLs would be a stored-XSS hole aimed at whoever opens
// the order next, in this dashboard or in wp-admin.
function isSafeHttpUrl(value) {
  if (value === "") return true; // explicit clear
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

app.patch("/api/admin/orders/:id", adminWriteLimiter, requireAdmin, async (req, res) => {
  try {
    const { status, tracking } = req.body || {};

    if (status !== undefined && !ALLOWED_ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: "That order status isn't allowed." });
    }
    if (tracking !== undefined) {
      if (typeof tracking !== "object" || tracking === null) {
        return res.status(400).json({ error: "Invalid tracking details." });
      }
      if (tracking.carrierUrl !== undefined && !isSafeHttpUrl(String(tracking.carrierUrl))) {
        return res.status(400).json({ error: "Tracking link must be a http:// or https:// URL." });
      }
    }

    const order = await updateWooOrder(req.params.id, { status, tracking });
    upsertOrder(order);
    res.json({ success: true, order });
  } catch (err) {
    console.error("admin-order-update error:", err.message);
    res.status(502).json({ error: "Could not save the change to WooCommerce." });
  }
});

// Staged product and banner images, served so WooCommerce can collect them.
//
// Public by necessity: WordPress fetches these over plain HTTP with no
// credential of ours. They are product photographs about to be published
// anyway, and the filenames carry random bytes so the directory cannot be
// walked by guessing.
const MEDIA_TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", avif: "image/avif",
};

app.get("/media/:id", (req, res) => {
  const file = mediaPathFor(req.params.id);
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  const ext = String(req.params.id).split(".").pop().toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) return res.status(404).end();
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "public, max-age=86400");
  fs.createReadStream(file).pipe(res);
});

// ---------------------------------------------------------------------------
// The local copy — every dashboard read comes from here, not from WordPress
// ---------------------------------------------------------------------------

app.get("/api/admin/store/status", adminDataLimiter, requireAdmin, (req, res) => {
  res.json({ success: true, ...storeStatus() });
});

app.post("/api/admin/store/sync", adminWriteLimiter, requireAdmin, async (req, res) => {
  res.json({ success: true, ...(await syncAll({ reason: "manual" })) });
});

// Every product, since inception. The old endpoint paged twenty at a time
// through WordPress because each page cost the better part of two seconds;
// this one is a filter over memory.
app.get("/api/admin/catalogue", adminDataLimiter, requireAdmin, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const need = String(req.query.need || "");
  let rows = allProducts();

  if (q) {
    rows = rows.filter((p) =>
      `${p.name} ${p.sku} ${(p.brands || []).map((b) => b.name).join(" ")}`.toLowerCase().includes(q));
  }
  // No `need` means the whole catalogue. "any" narrows to products the shop is
  // hiding; a specific value narrows to one reason.
  if (need === "any") rows = rows.filter((p) => (p.missing || []).length);
  else if (need) rows = rows.filter((p) => (p.missing || []).includes(need));

  // Price filtering is what makes a bulk change usable: "every product over
  // ₹2,000" is the rule someone actually wants to apply, not a list of ids.
  const priceOf = (p) => Number(p.salePrice || p.price || p.regularPrice || 0);
  const minPrice = Number(req.query.minPrice);
  const maxPrice = Number(req.query.maxPrice);
  if (Number.isFinite(minPrice)) rows = rows.filter((p) => priceOf(p) >= minPrice);
  if (Number.isFinite(maxPrice)) rows = rows.filter((p) => priceOf(p) <= maxPrice);

  const cod = String(req.query.cod || "any");
  if (cod === "off") rows = rows.filter((p) => p.codDisabled);
  else if (cod === "on") rows = rows.filter((p) => !p.codDisabled);

  const total = rows.length;
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(Math.max(1, Number(req.query.perPage) || 50), 500);
  res.json({
    success: true,
    total,
    page,
    perPage,
    products: rows.slice((page - 1) * perPage, page * perPage),
    // Every id behind the current filter, so "apply to all 340 of these" does
    // not mean paging through them first.
    matchingIds: rows.map((p) => p.id),
    counts: {
      all: allProducts().length,
      codOff: allProducts().filter((p) => p.codDisabled).length,
      missingImage: allProducts().filter((p) => (p.missing || []).includes("image")).length,
      missingDescription: allProducts().filter((p) => (p.missing || []).includes("description")).length,
      missingPrice: allProducts().filter((p) => (p.missing || []).includes("price")).length,
    },
  });
});

// Every order since inception, not the most recent hundred.
app.get("/api/admin/ledger", adminDataLimiter, requireAdmin, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const status = String(req.query.status || "any");
  let rows = allOrders();
  if (status !== "any") rows = rows.filter((o) => o.status === status);
  if (q) {
    rows = rows.filter((o) =>
      `${o.number} ${o.billing?.first_name || ""} ${o.billing?.last_name || ""} ${o.billing?.phone || ""} ${o.billing?.email || ""}`
        .toLowerCase().includes(q));
  }
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(Math.max(1, Number(req.query.perPage) || 50), 500);
  res.json({
    success: true,
    total: rows.length,
    page,
    perPage,
    orders: rows.slice((page - 1) * perPage, page * perPage),
  });
});

const CUSTOMER_SORTS = {
  value: (a, b) => b.lifetimeValue - a.lifetimeValue,
  orders: (a, b) => b.orders - a.orders,
  recent: (a, b) => String(b.lastOrderAt || "").localeCompare(String(a.lastOrderAt || "")),
  cancelled: (a, b) => b.cancelled - a.cancelled || b.cancelRate - a.cancelRate,
};

app.get("/api/admin/customers", adminDataLimiter, requireAdmin, (req, res) => {
  const { customers, unidentified } = buildCustomers(allOrders());
  const q = String(req.query.q || "").trim().toLowerCase();
  const pays = String(req.query.pays || "any");
  const risky = new Set(codRisks(customers).map((c) => c.phone));
  // Admin-only, so listing them here is fine — and without it the page cannot
  // show that a number has already been blocked, which left the button looking
  // like it had done nothing.
  const blocked = new Set(codRules().blockedPhones.map((b) => b.phone));

  let rows = customers.map((c) => ({ ...c, codBlocked: blocked.has(c.phone) }));
  if (q) rows = rows.filter((c) => `${c.name} ${c.phone} ${c.email} ${c.city} ${c.state}`.toLowerCase().includes(q));
  if (pays !== "any") rows = rows.filter((c) => c.pays === pays);
  if (req.query.repeat === "true") rows = rows.filter((c) => c.repeat);
  // The point of the screen: the numbers worth refusing cash on delivery to.
  if (req.query.risk === "true") rows = rows.filter((c) => risky.has(c.phone));
  if (req.query.blocked === "true") rows = rows.filter((c) => c.codBlocked);

  const sort = CUSTOMER_SORTS[req.query.sort] || CUSTOMER_SORTS.value;
  rows = [...rows].sort(sort);

  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(Math.max(1, Number(req.query.perPage) || 50), 500);
  res.json({
    success: true,
    total: rows.length,
    unidentified,
    summary: customerSummary(customers),
    atRisk: codRisks(customers).slice(0, 25).map((c) => ({ ...c, codBlocked: blocked.has(c.phone) })),
    blockedCount: blocked.size,
    customers: rows.slice((page - 1) * perPage, page * perPage),
    filtered: rows.length !== customers.length,
  });
});

// ---------------------------------------------------------------------------
// Tax — the monthly return
// ---------------------------------------------------------------------------

function hsnMap() {
  const map = {};
  for (const p of allProducts()) if (p.hsn) map[p.id] = p.hsn;
  return map;
}

app.get("/api/admin/tax/report", adminDataLimiter, requireAdmin, (req, res) => {
  const { from, to } = req.query;
  if (!isIsoDay(from) || !isIsoDay(to) || from > to) {
    return res.status(400).json({ error: "Invalid date range." });
  }
  const { summary, unreconciled, rows } = buildMtr(allOrders(), { from, to, hsnByProductId: hsnMap() });
  res.json({ success: true, summary, unreconciled, lines: rows.length });
});

app.get("/api/admin/tax/export", adminDataLimiter, requireAdmin, (req, res) => {
  const { from, to } = req.query;
  if (!isIsoDay(from) || !isIsoDay(to) || from > to) {
    return res.status(400).json({ error: "Invalid date range." });
  }
  const { csv } = buildMtr(allOrders(), { from, to, hsnByProductId: hsnMap() });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="MTR_B2C_${from}_to_${to}.csv"`);
  res.send(csv);
});

// ---------------------------------------------------------------------------
// Cash on delivery — when it is offered
// ---------------------------------------------------------------------------

// The products whose COD switch is off. Derived from the local copy, so this
// costs nothing and needs no WordPress call in the checkout path.
function blockedProductIds() {
  return new Set(allProducts().filter((p) => p.codDisabled).map((p) => Number(p.id)));
}

// Public: the checkout reads this to decide whether to offer COD at all.
// Deliberately carries no phone numbers — publishing a list of customers who
// have been refused would be both a privacy problem and useless to the page,
// which only ever needs to ask about the one number in front of it.
app.get("/api/cod-rules", (req, res) => {
  const r = codRules();
  res.setHeader("Cache-Control", "public, max-age=120");
  res.json({
    success: true,
    enabled: r.enabled,
    minOrderValue: r.minOrderValue,
    maxOrderValue: r.maxOrderValue,
    fee: r.fee,
    blockedProductIds: [...blockedProductIds()],
  });
});

// Answers one question about one number, so the checkout can say why before
// the customer fills in the rest of the form. Rate limited like any other
// public lookup, and it reveals nothing about a number you do not already have.
app.get("/api/cod-rules/phone", orderLookupLimiter, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ success: true, blocked: isPhoneBlocked(req.query.phone) });
});

app.get("/api/admin/cod-rules", adminDataLimiter, requireAdmin, (req, res) => {
  res.json({ success: true, rules: codRules(), blockedProducts: [...blockedProductIds()].length });
});

app.put("/api/admin/cod-rules", adminWriteLimiter, requireAdmin, (req, res) => {
  try {
    res.json({ success: true, rules: saveCodRules(req.body || {}) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/admin/cod-rules/block", adminWriteLimiter, requireAdmin, (req, res) => {
  try {
    res.json({ success: true, rules: blockPhone(req.body?.phone, req.body?.reason) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/admin/cod-rules/unblock", adminWriteLimiter, requireAdmin, (req, res) => {
  try {
    res.json({ success: true, rules: unblockPhone(req.body?.phone) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

// Public: the storefront reads this on every load, so it stays unauthenticated
// and cacheable.
app.get("/api/banners", (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=120");
  res.json({ success: true, banners: activeBanners() });
});

app.get("/api/admin/banners", adminDataLimiter, requireAdmin, (req, res) => {
  res.json({ success: true, banners: listBanners() });
});

app.put("/api/admin/banners", adminWriteLimiter, requireAdmin, (req, res) => {
  try {
    res.json({ success: true, banners: saveBanners(req.body?.banners) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Products — adding stock without opening wp-admin
// ---------------------------------------------------------------------------

// Reports whether file upload is available, so the dashboard can offer the
// right thing rather than failing at the moment someone drops a file.
app.get("/api/admin/products/capabilities", adminDataLimiter, requireAdmin, (req, res) => {
  res.json({ success: true, imageUpload: mediaUploadConfigured(), maxImageBytes: MAX_IMAGE_BYTES });
});

app.get("/api/admin/products/taxonomy", adminDataLimiter, requireAdmin, async (req, res) => {
  try {
    const [categories, brands] = await Promise.all([listTaxonomy("categories"), listTaxonomy("brands")]);
    res.json({ success: true, categories, brands });
  } catch (err) {
    console.error("admin-taxonomy error:", err.message);
    res.status(502).json({ error: "Could not load categories and brands." });
  }
});

// The repair queue: published products the storefront refuses to show.
app.get("/api/admin/products/incomplete", adminDataLimiter, requireAdmin, async (req, res) => {
  try {
    const need = ["image", "description", "price", "any"].includes(req.query.need) ? req.query.need : "any";
    const result = await listProductsNeedingWork({
      page: Number(req.query.page) || 1,
      perPage: Number(req.query.perPage) || 20,
      need,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("admin-incomplete-products error:", err.message);
    res.status(502).json({ error: "Could not load products from WooCommerce." });
  }
});

// Cash on delivery across many products at once — "every product over ₹2,000"
// rather than one switch at a time.
app.post("/api/admin/products/cod", adminWriteLimiter, requireAdmin, async (req, res) => {
  try {
    const { productIds, codDisabled } = req.body || {};
    const result = await setCodForProducts(productIds, Boolean(codDisabled));
    for (const p of result.products) upsertProduct(p);
    res.json({ success: true, updated: result.updated, codDisabled: Boolean(codDisabled) });
  } catch (err) {
    const status = err.status || 502;
    if (status >= 500) console.error("admin-bulk-cod error:", err.message);
    res.status(status).json({ error: err.message || "Could not change those products." });
  }
});

app.post("/api/admin/products/image", adminWriteLimiter, requireAdmin, async (req, res) => {
  try {
    const { base64, filename, contentType, productName, altText } = req.body || {};
    const image = await uploadProductImage({ base64, filename, contentType, productName, altText });
    res.json({ success: true, image });
  } catch (err) {
    const status = err.status || 502;
    if (status >= 500) console.error("admin-image-upload error:", err.message);
    res.status(status).json({ error: err.message || "Could not upload that image." });
  }
});

app.post("/api/admin/products", adminWriteLimiter, requireAdmin, async (req, res) => {
  try {
    const product = await createWooProduct(req.body || {});
    upsertProduct(product);
    res.json({ success: true, product });
  } catch (err) {
    const status = err.status || 502;
    if (status >= 500) console.error("admin-create-product error:", err.message);
    res.status(status).json({ error: err.message || "Could not create the product." });
  }
});

app.patch("/api/admin/products/:id", adminWriteLimiter, requireAdmin, async (req, res) => {
  try {
    const product = await updateWooProduct(req.params.id, req.body || {});
    upsertProduct(product);
    res.json({ success: true, product });
  } catch (err) {
    const status = err.status || 502;
    if (status >= 500) console.error("admin-update-product error:", err.message);
    res.status(status).json({ error: err.message || "Could not save the product." });
  }
});

app.post("/api/admin/orders/:id/notes", adminWriteLimiter, requireAdmin, async (req, res) => {
  try {
    const { note, customerNote } = req.body || {};
    if (!note || !String(note).trim()) {
      return res.status(400).json({ error: "Note can't be empty." });
    }
    const created = await addWooOrderNote(req.params.id, String(note).trim(), {
      customerNote: Boolean(customerNote),
    });
    res.json({ success: true, note: created });
  } catch (err) {
    console.error("admin-add-note error:", err.message);
    res.status(502).json({ error: "Could not save the note." });
  }
});

// Step 1 (online payment): price the cart from live WooCommerce data, apply
// any coupon, create a Razorpay order for the trusted total, cache the quote.
app.post("/api/create-payment", orderCreationLimiter, async (req, res) => {
  try {
    const { items, couponCode, customer, attribution } = req.body;
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

    const quote = { priced, coupon, shippingFee, total };
    quoteCache.set(razorpayOrder.id, quote);
    // Written to disk before the customer leaves for their UPI app, so the
    // webhook can finish the order even if they never come back.
    savePending(razorpayOrder.id, { quote, customer, attribution });

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
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, customer, items, couponCode, attribution } = req.body;

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

    const { order, duplicate } = await ensureOrderForPayment({
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      fallback: { customer, items, couponCode, attribution },
    });

    res.json({
      success: true,
      orderId: order.id,
      orderNumber: order.number,
      total: order.total,
      ...(duplicate ? { duplicate: true } : {}),
    });
  } catch (err) {
    // The customer's card has already been charged at this point, so this line
    // is the only record that money came in without an order behind it. Log it
    // loudly enough to be found when reconciling against Razorpay.
    console.error(
      `verify-payment error: ORDER NOT RECORDED for razorpay_payment_id=${req.body?.razorpay_payment_id} ` +
      `razorpay_order_id=${req.body?.razorpay_order_id}: ${err.message}`
    );
    res.status(500).json({ error: "Payment succeeded but we couldn't record your order. Please contact us with your payment ID." });
  }
});

// Cash on Delivery: no Razorpay involved, but still price from live data —
// never trust a client-submitted total for the amount collected on delivery.
app.post("/api/cod-order", orderCreationLimiter, async (req, res) => {
  try {
    const { items, customer, couponCode, attribution } = req.body;
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
    const collectable = discounted + shippingFee;

    // All three rules, checked here rather than trusted from the browser. The
    // checkout hides the option; this is what stops an order being created.
    const verdict = codAvailability({
      collectable,
      items: priced.items,
      phone: customer?.phone,
      blockedProductIds: new Set(allProducts().filter((p) => p.codDisabled).map((p) => Number(p.id))),
    });
    if (!verdict.allowed) {
      return res.status(400).json({ error: verdict.reason });
    }

    const total = collectable + codRules().fee;

    const order = await createWooOrder({
      pricedItems: priced,
      customer,
      paymentMethod: "cod",
      paymentTitle: "Cash on Delivery",
      setPaid: false,
      status: "processing",
      shippingFee,
      codFee: codRules().fee,
      coupon,
      attribution,
      metaData: [{ key: "cod_fee", value: String(codRules().fee) }],
    });

    res.json({ success: true, orderId: order.id, orderNumber: order.number, total: order.total });
  } catch (err) {
    // A COD order has no second chance. An online payment that fails here is
    // still rescued by Razorpay's webhook, but nothing calls back for COD — if
    // WooCommerce is slow or down, the customer just sees an error and the
    // order is gone, with no record that they ever tried. Park the details so
    // the order can be placed by hand instead of being lost.
    const reference = `cod_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    savePending(reference, {
      quote: null,
      customer: req.body?.customer,
      attribution: req.body?.attribution,
    });
    console.error(
      `cod-order error: ORDER NOT RECORDED ref=${reference} ` +
      `phone=${normalizePhone(req.body?.customer?.phone)} items=${JSON.stringify(req.body?.items)}: ${err.message}`
    );
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

startStore();
cleanupMedia();

app.listen(PORT, () => {
  console.log(`SB Ayurveda bridge server listening on :${PORT}`);
  console.log(`pending-order store: ${pendingDir()}`);
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.warn(
      "WARNING: RAZORPAY_WEBHOOK_SECRET is not set — the Razorpay webhook is disabled, " +
      "so an order still depends on the customer's browser returning from their payment app."
    );
  }
  // Clear out records for payments that were abandoned and never captured.
  cleanupOld();
  setInterval(cleanupOld, 12 * 60 * 60 * 1000).unref();
});
