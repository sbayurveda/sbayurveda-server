import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// A fake WooCommerce that records the PUT body, so what we send can be
// asserted rather than assumed. The module is re-imported per test with fetch
// stubbed, because the payload is the whole point.
async function capture(args) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sent.push({ url: String(url), body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({
        id: 1, number: "1", status: "processing", total: "100", line_items: [],
        meta_data: [], billing: {}, shipping: {}, fee_lines: [], refunds: [], coupon_lines: [],
      }),
    };
  };
  try {
    const { updateWooOrder } = await import(`../woocommerce.js?p=${Math.random()}`);
    await updateWooOrder(1, args);
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent[0]?.body ?? {};
}

describe("recording that cash was collected", () => {
  test("marking paid does not touch the order's status", async () => {
    // The bug this guards: dispatching a COD order marked it paid, because
    // payment was expressed by moving it to completed. The two are separate
    // facts and must travel separately.
    const body = await capture({ markPaid: true });
    assert.equal(body.set_paid, true);
    assert.equal("status" in body, false);
  });

  test("changing status does not mark anything paid", async () => {
    const body = await capture({ status: "completed" });
    assert.equal(body.status, "completed");
    assert.equal("set_paid" in body, false);
  });

  test("false is not an instruction to unpay", async () => {
    // Reversing a payment is a refund, with its own record. A bulk action
    // must not be able to erase one by sending false.
    await assert.rejects(capture({ markPaid: false }), /Nothing to update/);
  });

  test("only the literal true counts", async () => {
    for (const truthy of ["yes", 1, {}]) {
      await assert.rejects(capture({ markPaid: truthy }), /Nothing to update/, String(truthy));
    }
  });

  test("payment and status can still be sent together when both are meant", async () => {
    const body = await capture({ status: "completed", markPaid: true });
    assert.equal(body.status, "completed");
    assert.equal(body.set_paid, true);
  });
});

describe("correcting a delivery address", () => {
  test("only the fields supplied are sent", async () => {
    // A partial edit must not blank the rest of the address.
    const body = await capture({ shipping: { address_1: "12 New Road", postcode: "122002" } });
    assert.deepEqual(body.shipping, { address_1: "12 New Road", postcode: "122002" });
    assert.equal("billing" in body, false);
    assert.equal("status" in body, false);
  });

  test("a field the order has no business carrying is dropped", async () => {
    const body = await capture({ shipping: { address_1: "x", email: "a@b.c", total: "99999" } });
    assert.equal("email" in body.shipping, false, "shipping has no email in WooCommerce");
    assert.equal("total" in body.shipping, false, "a total is not an address field");
  });

  test("billing keeps its email and phone", async () => {
    const body = await capture({ billing: { email: "a@b.c", phone: "9811000001" } });
    assert.equal(body.billing.email, "a@b.c");
    assert.equal(body.billing.phone, "9811000001");
  });

  test("an address change does not touch status or payment", async () => {
    const body = await capture({ billing: { city: "Gurgaon" } });
    assert.deepEqual(Object.keys(body), ["billing"]);
  });

  test("an empty address object is not a change", async () => {
    await assert.rejects(capture({ shipping: {} }), /Nothing to update/);
  });
});
