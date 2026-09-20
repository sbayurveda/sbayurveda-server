// End-to-end tests for the path a payment takes to becoming an order.
//
// These exist because that path failed silently in production: eleven UPI
// payments totalling Rs5,201 were taken without an order being created, and
// nothing caught it until customers rang up. Each test below pins one way that
// could happen again.
//
// Uses node:test so the payment server gains no dependencies — an earlier
// attempt to add one took payments offline for days when it wasn't installed
// in the runtime.
//
// No network: WooCommerce is mocked over HTTP, and the payment draft that
// create-payment would normally write is seeded straight onto disk. That keeps
// the tests off Razorpay's live API, which is also why they can run anywhere.
//
// Run with: npm test

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const WEBHOOK_SECRET = "test-webhook-secret";
const RAZORPAY_SECRET = "test-razorpay-secret";
const MOCK_WC_PORT = 4711;
const SERVER_PORT = 4712;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

let wcServer;
let serverProcess;
let pendingDir;

// --- mock WooCommerce --------------------------------------------------------
const wc = { orders: [], notes: [], statusUpdates: {}, failOrderCreation: false, puts: [] };

function startMockWooCommerce() {
  return new Promise((resolve) => {
    wcServer = http.createServer((req, res) => {
      const json = (obj) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(obj));
      };
      const readBody = (cb) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => cb(JSON.parse(body || "{}")));
      };

      // Pricing asks for the whole cart in one collection request. Echo back a
      // product per requested id so the fallback re-pricing path is exercised
      // for real rather than short-circuited.
      if (req.url.includes("/wc/store/v1/products")) {
        const ids = (new URL(req.url, "http://x").searchParams.get("include") || "1")
          .split(",")
          .filter(Boolean);
        // Product 2 is deliberately cheap, so a cart can be built that falls
        // below the cash-on-delivery floor. Everything else is Rs500.
        return json(
          ids.map((id) => ({
            id: Number(id),
            name: "Test Product",
            is_purchasable: true,
            is_in_stock: true,
            prices:
              Number(id) === 2
                ? { price: "5000", regular_price: "6000" }
                : { price: "50000", regular_price: "60000" },
          })),
        );
      }
      if (req.method === "PUT" && /\/wc\/v3\/orders\/\d+$/.test(req.url)) {
        return readBody((b) => {
          const id = Number(req.url.match(/orders\/(\d+)/)[1]);
          const existing = wc.orders.find((o) => o.id === id) || {};
          wc.puts.push({ id, body: b });
          if (b.status) wc.statusUpdates[id] = b.status;
          json({ ...existing, ...b, id, number: String(id), meta_data: existing.meta_data || [] });
        });
      }
      if (req.method === "POST" && /\/wc\/v3\/orders\/\d+\/notes/.test(req.url)) {
        return readBody((b) => {
          wc.notes.push(b.note);
          json({ id: wc.notes.length, note: b.note, date_created: new Date().toISOString() });
        });
      }
      if (req.method === "POST" && req.url.includes("/wc/v3/orders")) {
        if (wc.failOrderCreation) {
          res.statusCode = 503;
          return res.end("WooCommerce unavailable");
        }
        return readBody((b) => {
          const id = 6000 + wc.orders.length + 1;
          const order = {
            id,
            number: String(id),
            total: "500.00",
            // Faithful to WooCommerce: marking an order paid runs
            // payment_complete(), which forces processing and overrides
            // whatever status was asked for. Reproducing that here is the
            // whole point — an on-hold request alone is silently ignored.
            status: b.set_paid ? "processing" : (b.status || "processing"),
            billing: b.billing,
            meta_data: b.meta_data || [],
            transaction_id: b.transaction_id,
          };
          wc.orders.push(order);
          json(order);
        });
      }
      res.statusCode = 404;
      res.end("{}");
    });
    wcServer.listen(MOCK_WC_PORT, resolve);
  });
}

function startServer() {
  pendingDir = mkdtempSync(join(tmpdir(), "sba-test-"));
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      RAZORPAY_KEY_ID: "rzp_test_key",
      RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      WC_BASE_URL: `http://127.0.0.1:${MOCK_WC_PORT}`,
      WC_CONSUMER_KEY: "ck_test",
      WC_CONSUMER_SECRET: "cs_test",
      ALLOWED_ORIGINS: "http://localhost:5173",
      ADMIN_USER: "tester",
      ADMIN_PASSWORD: "test-admin-password",
      ADMIN_TOKEN_SECRET: "test-admin-token-secret",
      PENDING_ORDER_DIR: pendingDir,
    },
    stdio: "ignore",
  });

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const poll = async () => {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) return resolve();
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) return reject(new Error("server did not start"));
      setTimeout(poll, 200);
    };
    poll();
  });
}

// --- helpers -----------------------------------------------------------------
const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const CUSTOMER = {
  name: "Test Customer",
  email: "test@example.com",
  phone: "9876543210",
  flatBuilding: "12 Test Building",
  area: "Test Area",
  city: "Kurukshetra",
  state: "Haryana",
  pincode: "136156",
};

const QUOTE = {
  priced: {
    items: [{ wcId: 1, name: "Test Product", price: 500, mrp: 600, qty: 1 }],
    subtotal: 500,
    mrpTotal: 600,
    savings: 100,
  },
  coupon: { valid: false, discount: 0 },
  shippingFee: 0,
};

// Writes the draft that create-payment would write when the customer starts
// paying. Seeded directly so the tests never touch Razorpay's live API.
function seedDraft(razorpayOrderId, { customer } = {}) {
  writeFileSync(
    join(pendingDir, `${razorpayOrderId}.json`),
    JSON.stringify({
      razorpayOrderId,
      quote: QUOTE,
      customer,
      attribution: { sourceType: "organic" },
      createdAt: Date.now(),
      order: null,
    })
  );
}

const readDraft = (id) => JSON.parse(readFileSync(join(pendingDir, `${id}.json`), "utf8"));

const webhookBody = (razorpayOrderId, paymentId) => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: paymentId, order_id: razorpayOrderId, amount: 50000 } } },
});

const sign = (payload, secret) =>
  crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");

const paymentSignature = (orderId, paymentId) =>
  crypto.createHmac("sha256", RAZORPAY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");

before(async () => {
  await startMockWooCommerce();
  await startServer();
});

after(() => {
  serverProcess?.kill();
  wcServer?.close();
  if (pendingDir) rmSync(pendingDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------

describe("the delivery address is on file before payment starts", () => {
  test("a draft holds the customer, cart and source", async () => {
    // The production bug was that the frontend API client dropped `customer`
    // before the request left the browser, so this draft had no address and the
    // webhook had nothing to build an order from.
    const { savePending, readRecord } = await import("../pendingOrders.js");
    process.env.PENDING_ORDER_DIR = pendingDir;

    savePending("order_draft_test", {
      quote: QUOTE,
      customer: CUSTOMER,
      attribution: { sourceType: "utm", utmSource: "google" },
    });
    const record = readRecord("order_draft_test");

    assert.ok(record, "a draft must be written when payment starts");
    assert.equal(record.customer.email, CUSTOMER.email);
    assert.equal(record.customer.phone, CUSTOMER.phone);
    assert.equal(record.customer.pincode, CUSTOMER.pincode, "the address must survive");
    assert.equal(record.quote.priced.items.length, 1, "the cart must survive");
    assert.equal(record.attribution.sourceType, "utm");
  });
});

describe("a captured payment always becomes an order", () => {
  test("customer returns from the payment app", async () => {
    const orderId = "order_returns";
    const paymentId = "pay_returns";
    seedDraft(orderId, { customer: CUSTOMER });
    const before = wc.orders.length;

    const res = await post("/api/verify-payment", {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: paymentSignature(orderId, paymentId),
      customer: CUSTOMER,
      items: [{ id: "wc-1", qty: 1 }],
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.ok(body.orderNumber);
    assert.equal(wc.orders.length, before + 1);
    assert.equal(wc.orders.at(-1).status, "processing");
  });

  test("customer never returns — the webhook creates it alone", async () => {
    // The UPI case: the phone goes to GPay and never comes back, so nothing
    // client-side ever reports the payment.
    const orderId = "order_never_returns";
    const paymentId = "pay_never_returns";
    seedDraft(orderId, { customer: CUSTOMER });
    const before = wc.orders.length;

    const body = webhookBody(orderId, paymentId);
    const res = await post("/api/razorpay/webhook", body, {
      "x-razorpay-signature": sign(body, WEBHOOK_SECRET),
    });

    assert.equal(res.status, 200);
    assert.equal(wc.orders.length, before + 1, "the webhook must create the order by itself");
    assert.equal(wc.orders.at(-1).status, "processing");
    assert.equal(wc.orders.at(-1).transaction_id, paymentId, "payment id must be recorded");
  });

  test("no address on file — an on-hold needs-review order is still created", async () => {
    // Exactly the production state: a draft with a cart but no customer.
    const orderId = "order_no_details";
    const paymentId = "pay_no_details";
    seedDraft(orderId, { customer: undefined });
    const before = wc.orders.length;
    const notesBefore = wc.notes.length;

    const body = webhookBody(orderId, paymentId);
    const res = await post("/api/razorpay/webhook", body, {
      "x-razorpay-signature": sign(body, WEBHOOK_SECRET),
    });

    assert.equal(res.status, 200, "must not fail — the money is already taken");
    assert.equal(wc.orders.length, before + 1, "an order must exist even with no address");

    const order = wc.orders.at(-1);
    // WooCommerce moves a paid order to processing regardless of the status
    // asked for at creation, so the hold is applied as a follow-up update.
    // Assert on the final state, which is what dispatch actually sees.
    const finalStatus = wc.statusUpdates[order.id] || order.status;
    assert.equal(finalStatus, "on-hold", "must not enter the dispatch queue");
    assert.ok(
      order.meta_data.some((m) => m.key === "_sba_needs_review" && m.value === "yes"),
      "must be flagged for review"
    );
    assert.ok(
      order.meta_data.some((m) => m.key === "razorpay_payment_id" && m.value === paymentId),
      "payment id must be attached for reconciliation"
    );
    assert.ok(wc.notes.length > notesBefore, "an admin note must explain what is missing");
    assert.match(wc.notes.at(-1), /NEEDS REVIEW/);
  });
});

describe("one payment can only ever produce one order", () => {
  test("a repeated webhook does not create a second order", async () => {
    const orderId = "order_repeat";
    const paymentId = "pay_repeat";
    seedDraft(orderId, { customer: CUSTOMER });

    const body = webhookBody(orderId, paymentId);
    const headers = { "x-razorpay-signature": sign(body, WEBHOOK_SECRET) };

    await post("/api/razorpay/webhook", body, headers);
    const after1 = wc.orders.length;
    const second = await (await post("/api/razorpay/webhook", body, headers)).json();

    assert.equal(wc.orders.length, after1, "a Razorpay retry must not duplicate the order");
    assert.equal(second.duplicate, true);
  });

  test("webhook and browser arriving together still yield one order", async () => {
    const orderId = "order_race";
    const paymentId = "pay_race";
    seedDraft(orderId, { customer: CUSTOMER });
    const before = wc.orders.length;

    const body = webhookBody(orderId, paymentId);
    await Promise.all([
      post("/api/razorpay/webhook", body, { "x-razorpay-signature": sign(body, WEBHOOK_SECRET) }),
      post("/api/verify-payment", {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: paymentSignature(orderId, paymentId),
        customer: CUSTOMER,
        items: [{ id: "wc-1", qty: 1 }],
      }),
    ]);

    assert.equal(wc.orders.length, before + 1, "a race must not produce two orders");
  });

  test("the created order is recorded on the draft, so it survives a restart", async () => {
    const orderId = "order_persisted";
    const paymentId = "pay_persisted";
    seedDraft(orderId, { customer: CUSTOMER });

    const body = webhookBody(orderId, paymentId);
    await post("/api/razorpay/webhook", body, {
      "x-razorpay-signature": sign(body, WEBHOOK_SECRET),
    });

    const draft = readDraft(orderId);
    assert.ok(draft.order?.number, "the order must be written back to the draft on disk");
  });
});

describe("webhook authenticity", () => {
  test("an unsigned or forged call is rejected and creates nothing", async () => {
    const orderId = "order_forged";
    seedDraft(orderId, { customer: CUSTOMER });
    const before = wc.orders.length;
    const body = webhookBody(orderId, "pay_forged");

    const noSig = await post("/api/razorpay/webhook", body);
    const badSig = await post("/api/razorpay/webhook", body, { "x-razorpay-signature": "deadbeef" });

    assert.equal(noSig.status, 400);
    assert.equal(badSig.status, 400);
    assert.equal(wc.orders.length, before, "a forged call must never create an order");
  });

  test("events other than payment.captured are acknowledged but ignored", async () => {
    const before = wc.orders.length;
    const body = {
      event: "payment.authorized",
      payload: { payment: { entity: { id: "pay_auth", order_id: "order_auth" } } },
    };
    const res = await post("/api/razorpay/webhook", body, {
      "x-razorpay-signature": sign(body, WEBHOOK_SECRET),
    });
    const json = await res.json();

    // Acknowledged so Razorpay stops retrying, but no order — the money is only
    // guaranteed on capture.
    assert.equal(res.status, 200);
    assert.equal(json.ignored, "payment.authorized");
    assert.equal(wc.orders.length, before);
  });
});

// Cash on Delivery has no equivalent of the Razorpay webhook: nothing calls the
// server back, so whatever happens on this one request is the whole story.
describe("cash on delivery", () => {
  test("a COD order is created from live prices, with the COD fee added", async () => {
    wc.failOrderCreation = false;
    const before = wc.orders.length;

    const res = await post("/api/cod-order", {
      items: [{ id: "wc-1", qty: 2 }],
      customer: CUSTOMER,
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(wc.orders.length, before + 1);

    const order = wc.orders[wc.orders.length - 1];
    // Not paid up front, and it must not arrive marked as paid.
    assert.equal(order.status, "processing");
    assert.ok(
      order.meta_data.some((m) => m.key === "cod_fee"),
      "the collected amount has to record the COD fee",
    );
  });

  test("an order lost to a WooCommerce outage still leaves the customer on file", async () => {
    // The failure this covers is silent loss: the customer sees an error, hangs
    // up, and there is nothing anywhere saying they tried to buy.
    wc.failOrderCreation = true;
    const before = wc.orders.length;

    const res = await post("/api/cod-order", {
      items: [{ id: "wc-1", qty: 1 }],
      customer: CUSTOMER,
    });

    assert.equal(res.status, 500);
    assert.equal(wc.orders.length, before, "no half-made order");

    const parked = readdirSync(pendingDir)
      .filter((f) => f.startsWith("cod_"))
      .map((f) => JSON.parse(readFileSync(join(pendingDir, f), "utf8")));

    assert.equal(parked.length, 1, "the attempt must be recoverable by hand");
    assert.equal(parked[0].customer.phone, CUSTOMER.phone);
    assert.equal(parked[0].customer.pincode, CUSTOMER.pincode, "the address has to survive too");

    wc.failOrderCreation = false;
  });

  test("one failure does not stop the next customer ordering", async () => {
    const before = wc.orders.length;
    const res = await post("/api/cod-order", { items: [{ id: "wc-1", qty: 1 }], customer: CUSTOMER });

    assert.equal(res.status, 200);
    assert.equal(wc.orders.length, before + 1);
  });
});

// Cash on Delivery is offered only inside a band of order values. The checkout
// hides the option outside it, but that is a hint to a browser we don't control.
// The mock product is Rs500, and delivery adds Rs54 below the free-shipping
// threshold, so quantity is what moves the collectable amount here.
describe("the cash-on-delivery band", () => {
  test("a cart over the ceiling is refused, and no order is created", async () => {
    wc.failOrderCreation = false;
    const before = wc.orders.length;

    // 6 x Rs500 = Rs3,000 of goods, past the Rs2,200 ceiling.
    const res = await post("/api/cod-order", {
      items: [{ id: "wc-1", qty: 6 }],
      customer: CUSTOMER,
    });
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.match(json.error, /isn't available above/);
    assert.equal(wc.orders.length, before, "nothing may be booked");
  });

  test("a cart inside the band goes through", async () => {
    const before = wc.orders.length;
    // 2 x Rs500 + Rs54 delivery = Rs1,054.
    const res = await post("/api/cod-order", { items: [{ id: "wc-1", qty: 2 }], customer: CUSTOMER });

    assert.equal(res.status, 200);
    assert.equal(wc.orders.length, before + 1);
  });

  test("the ceiling is checked on what the courier collects, not the goods alone", async () => {
    // 4 x Rs500 = Rs2,000 of goods — under the ceiling on its own, and still
    // under once delivery is added, so this must be accepted.
    const before = wc.orders.length;
    const res = await post("/api/cod-order", { items: [{ id: "wc-1", qty: 4 }], customer: CUSTOMER });

    assert.equal(res.status, 200);
    assert.equal(wc.orders.length, before + 1);
  });

  test("a cart under the floor is refused, and no order is created", async () => {
    const before = wc.orders.length;
    // 2 x Rs50 = Rs100 of goods, Rs154 with delivery — under the Rs300 floor.
    const res = await post("/api/cod-order", { items: [{ id: "wc-2", qty: 2 }], customer: CUSTOMER });
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.match(json.error, /isn't available below/);
    assert.equal(wc.orders.length, before, "nothing may be booked");
  });

  test("a small cart that clears the floor once delivery is added is accepted", async () => {
    // 5 x Rs50 = Rs250 of goods; Rs304 is what the courier actually collects,
    // and that is what the floor is measured against.
    const before = wc.orders.length;
    const res = await post("/api/cod-order", { items: [{ id: "wc-2", qty: 5 }], customer: CUSTOMER });

    assert.equal(res.status, 200);
    assert.equal(wc.orders.length, before + 1);
  });

  test("paying online is not restricted at either end", async () => {
    // The band exists because of COD refusals and handling cost, not order size.
    const big = await post("/api/create-payment", { items: [{ id: "wc-1", qty: 6 }], customer: CUSTOMER });
    assert.notEqual(big.status, 400);
    const small = await post("/api/create-payment", { items: [{ id: "wc-2", qty: 1 }], customer: CUSTOMER });
    assert.notEqual(small.status, 400);
  });
});

describe("editing an order from the dashboard", () => {
  let token;

  before(async () => {
    const res = await post("/api/admin/login", { username: "tester", password: "test-admin-password" });
    ({ token } = await res.json());
    assert.ok(token, "the test admin should be able to sign in");
  });

  const patch = (id, body) =>
    fetch(`${BASE}/api/admin/orders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  test("status and tracking save in a single write, not two", async () => {
    // Two writes meant two WordPress round trips, which is what made saving
    // feel slow — and left a window where the status had moved but the
    // tracking had not.
    wc.puts = [];
    const res = await patch(6001, {
      status: "completed",
      tracking: {
        pickedUp: true,
        carrierName: "Amazon Shipping",
        trackingCode: "372225471072",
        carrierUrl: "https://track.amazon.in/tracking/372225471072",
        pickUpDate: "2026-09-13",
      },
    });

    assert.equal(res.status, 200);
    assert.equal(wc.puts.length, 1, `expected 1 write, made ${wc.puts.length}`);

    const { body } = wc.puts[0];
    assert.equal(body.status, "completed");
    const meta = Object.fromEntries(body.meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta.ywot_carrier_name, "Amazon Shipping");
    assert.equal(meta.ywot_tracking_code, "372225471072");
    assert.equal(meta.ywot_carrier_url, "https://track.amazon.in/tracking/372225471072");
    assert.equal(meta.ywot_pick_up_date, "2026-09-13");
  });

  test("the pickup switch is stored the way YITH reads it", async () => {
    // YITH checks for the string "yes"; a JSON true would silently never match
    // and the customer would never see tracking.
    wc.puts = [];
    await patch(6001, { tracking: { pickedUp: true } });
    assert.equal(wc.puts[0].body.meta_data[0].value, "yes");

    wc.puts = [];
    await patch(6001, { tracking: { pickedUp: false } });
    assert.equal(wc.puts[0].body.meta_data[0].value, "no");
  });

  test("a tracking link that isn't a real URL is refused", async () => {
    const res = await patch(6001, { tracking: { carrierUrl: "javascript:alert(1)" } });
    assert.equal(res.status, 400);
  });

  test("an unknown status is refused", async () => {
    const res = await patch(6001, { status: "definitely-not-a-status" });
    assert.equal(res.status, 400);
  });

  test("editing requires a signed-in admin", async () => {
    const res = await fetch(`${BASE}/api/admin/orders/6001`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    assert.equal(res.status, 401);
  });
});
