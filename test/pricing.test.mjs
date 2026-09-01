// Checkout used to make one WooCommerce round trip per cart line, awaited in
// series, so "Placing Order..." got slower the more the customer bought — a
// measured 5.5s median on a four-item cart against the live store. These tests
// pin the fix: one request for the whole cart, with every price and stock check
// still enforced.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const PORT = 4721;

// Every request the pricing code makes, so a regression back to per-item
// fetching is visible as a count rather than as a slow test.
let requests = [];
let catalogue = {};
let handler = null; // set to override the response for one test
let server;

function startMockStore() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      requests.push(req.url);
      if (handler) return handler(req, res);

      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const include = (url.searchParams.get("include") || "")
        .split(",")
        .filter(Boolean);
      const found = include.map((id) => catalogue[id]).filter(Boolean);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(found));
    });
    server.listen(PORT, resolve);
  });
}

const product = (id, { price = "50000", regular = "60000", stock = true, purchasable = true, name } = {}) => ({
  id: Number(id),
  name: name || `Product ${id}`,
  is_purchasable: purchasable,
  is_in_stock: stock,
  prices: { price, regular_price: regular },
});

let priceCartItems;

before(async () => {
  await startMockStore();
  process.env.WC_BASE_URL = `http://127.0.0.1:${PORT}`;
  ({ priceCartItems } = await import("../woocommerce.js"));
});

after(() => server.close());

function reset(products) {
  requests = [];
  handler = null;
  catalogue = Object.fromEntries(products.map((p) => [String(p.id), p]));
}

describe("pricing a cart", () => {
  test("a four-item cart costs one request, not four", async () => {
    reset([product(1), product(2), product(3), product(4)]);

    await priceCartItems([
      { id: "wc-1", qty: 1 }, { id: "wc-2", qty: 1 },
      { id: "wc-3", qty: 1 }, { id: "wc-4", qty: 1 },
    ]);

    assert.equal(requests.length, 1, `expected 1 request, made ${requests.length}: ${requests}`);
    assert.match(requests[0], /include=1,2,3,4/);
  });

  test("cart size does not change the number of requests", async () => {
    reset(Array.from({ length: 20 }, (_, i) => product(i + 1)));
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `wc-${i + 1}`, qty: 1 }));

    await priceCartItems(items);
    assert.equal(requests.length, 1);
  });

  test("totals are computed from the live price, not the client's", async () => {
    reset([product(1, { price: "51500", regular: "60000" }), product(2, { price: "10000", regular: "12500" })]);

    const result = await priceCartItems([{ id: "wc-1", qty: 2 }, { id: "wc-2", qty: 3 }]);

    assert.equal(result.subtotal, 515 * 2 + 100 * 3);
    assert.equal(result.mrpTotal, 600 * 2 + 125 * 3);
    assert.equal(result.savings, result.mrpTotal - result.subtotal);
  });

  test("line order and quantities survive the batching", async () => {
    // The API returns the collection in its own order; the cart's order is ours.
    reset([product(7, { name: "Seven" }), product(3, { name: "Three" })]);

    const { items } = await priceCartItems([{ id: "wc-7", qty: 5 }, { id: "wc-3", qty: 2 }]);

    assert.deepEqual(items.map((i) => [i.name, i.qty]), [["Seven", 5], ["Three", 2]]);
  });

  test("the same product twice is fetched once but priced twice", async () => {
    reset([product(1)]);

    const { items, subtotal } = await priceCartItems([{ id: "wc-1", qty: 1 }, { id: "wc-1", qty: 2 }]);

    assert.equal(requests.length, 1);
    assert.match(requests[0], /include=1(&|$)/);
    assert.equal(items.length, 2);
    assert.equal(subtotal, 500 * 3);
  });
});

describe("what must still be refused", () => {
  test("an out-of-stock item stops the order, by name", async () => {
    reset([product(1), product(2, { stock: false, name: "Ashwagandha Churna" })]);

    await assert.rejects(
      priceCartItems([{ id: "wc-1", qty: 1 }, { id: "wc-2", qty: 1 }]),
      /Ashwagandha Churna is currently out of stock/,
    );
  });

  test("an unpurchasable item stops the order", async () => {
    reset([product(1, { purchasable: false })]);
    await assert.rejects(priceCartItems([{ id: "wc-1", qty: 1 }]), /no longer purchasable/);
  });

  test("a deleted product stops the order rather than being skipped", async () => {
    // The collection simply omits ids it can't find. Silently pricing the rest
    // would charge the customer for a cart they didn't submit.
    reset([product(1)]);
    await assert.rejects(priceCartItems([{ id: "wc-1", qty: 1 }, { id: "wc-999", qty: 1 }]), /not found or unavailable/);
  });

  test("a junk product id is rejected before any request is made", async () => {
    reset([]);
    await assert.rejects(priceCartItems([{ id: "wc-abc", qty: 1 }]), /Invalid product id/);
    assert.equal(requests.length, 0);
  });
});

describe("when WooCommerce misbehaves", () => {
  test("a failed read is retried once before giving up", async () => {
    reset([product(1)]);
    let calls = 0;
    handler = (req, res) => {
      calls += 1;
      if (calls === 1) {
        res.statusCode = 502;
        return res.end("bad gateway");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([product(1)]));
    };

    const { subtotal } = await priceCartItems([{ id: "wc-1", qty: 1 }]);
    assert.equal(subtotal, 500);
    assert.equal(calls, 2, "should have retried exactly once");
  });

  test("a persistently failing store surfaces an error instead of hanging", async () => {
    reset([product(1)]);
    handler = (req, res) => {
      res.statusCode = 500;
      res.end("down");
    };

    await assert.rejects(priceCartItems([{ id: "wc-1", qty: 1 }]));
    assert.equal(requests.length, 2, "gives up after one retry rather than looping");
  });
});
