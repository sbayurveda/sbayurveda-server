// Customers exist only as a pattern across orders — there are no accounts.
// The number that earns the screen is the cancellation rate per phone: COD
// cancels at 27.5% against 1.8% prepaid, and that cost sits on a few numbers.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildCustomers, phoneKey, codRisks, customerSummary } from "../customers.js";

const o = (over = {}) => ({
  id: 1, number: "1", status: "processing", total: "500.00",
  dateCreated: "2026-09-01T10:00:00", paymentMethod: "cod",
  billing: { first_name: "A", last_name: "B", phone: "9876543210", city: "Hisar", state: "Haryana" },
  ...over,
});

describe("identifying a person across orders", () => {
  test("the same number written three ways is one customer", () => {
    assert.equal(phoneKey("9876543210"), "9876543210");
    assert.equal(phoneKey("+919876543210"), "9876543210");
    assert.equal(phoneKey("09876543210"), "9876543210");
    assert.equal(phoneKey("+91 98765 43210"), "9876543210");
  });

  test("a number too short to be real is not an identity", () => {
    assert.equal(phoneKey("12345"), "");
    assert.equal(phoneKey(""), "");
    assert.equal(phoneKey(null), "");
  });

  test("orders with no usable phone are counted, not merged into one customer", () => {
    // A blank key would invent a single enormous customer out of everyone
    // we could not identify.
    const { customers, unidentified } = buildCustomers([
      o({ id: 1, billing: { phone: "" } }),
      o({ id: 2, billing: { phone: "123" } }),
    ]);
    assert.equal(customers.length, 0);
    assert.equal(unidentified, 2);
  });

  test("three orders from one number make one customer", () => {
    const { customers } = buildCustomers([
      o({ id: 1, total: "500.00" }),
      o({ id: 2, total: "300.00", billing: { phone: "+919876543210" } }),
      o({ id: 3, total: "200.00", billing: { phone: "09876543210" } }),
    ]);
    assert.equal(customers.length, 1);
    assert.equal(customers[0].orders, 3);
    assert.equal(customers[0].lifetimeValue, 1000);
  });
});

describe("what the list says about money", () => {
  test("a cancelled order counts against the rate but not the lifetime value", () => {
    const { customers } = buildCustomers([
      o({ id: 1, total: "500.00", status: "processing" }),
      o({ id: 2, total: "900.00", status: "cancelled" }),
    ]);
    const c = customers[0];
    assert.equal(c.lifetimeValue, 500, "cancelled money was never collected");
    assert.equal(c.placed, 2);
    assert.equal(c.cancelled, 1);
    assert.equal(c.cancelRate, 50);
  });

  test("refunded is treated the same as cancelled", () => {
    const { customers } = buildCustomers([o({ id: 1, total: "500.00", status: "refunded" })]);
    assert.equal(customers[0].lifetimeValue, 0);
    assert.equal(customers[0].cancelled, 1);
  });

  test("how they pay is recorded, including mixed", () => {
    const cod = buildCustomers([o({ paymentMethod: "cod" })]).customers[0];
    const pre = buildCustomers([o({ paymentMethod: "razorpay" })]).customers[0];
    const mix = buildCustomers([o({ id: 1, paymentMethod: "cod" }), o({ id: 2, paymentMethod: "razorpay" })]).customers[0];
    assert.equal(cod.pays, "cod");
    assert.equal(pre.pays, "prepaid");
    assert.equal(mix.pays, "mixed");
  });

  test("the most recent address wins, because that is the one worth calling", () => {
    const { customers } = buildCustomers([
      o({ id: 1, dateCreated: "2026-01-01T00:00:00", billing: { phone: "9876543210", first_name: "Old", city: "Hisar" } }),
      o({ id: 2, dateCreated: "2026-09-01T00:00:00", billing: { phone: "9876543210", first_name: "New", city: "Panipat" } }),
    ]);
    assert.equal(customers[0].name, "New");
    assert.equal(customers[0].city, "Panipat");
    assert.equal(customers[0].firstOrderAt.slice(0, 10), "2026-01-01");
    assert.equal(customers[0].lastOrderAt.slice(0, 10), "2026-09-01");
  });

  test("the list is sorted by what each customer is worth", () => {
    const { customers } = buildCustomers([
      o({ id: 1, total: "100.00", billing: { phone: "9000000001" } }),
      o({ id: 2, total: "900.00", billing: { phone: "9000000002" } }),
    ]);
    assert.deepEqual(customers.map((c) => c.lifetimeValue), [900, 100]);
  });
});

describe("who to stop offering COD to", () => {
  const serial = Array.from({ length: 5 }, (_, i) =>
    o({ id: i + 1, status: i < 4 ? "cancelled" : "processing", billing: { phone: "9111111111" } }));
  const unlucky = [o({ id: 9, status: "cancelled", billing: { phone: "9222222222" } })];

  test("a number that keeps cancelling COD is flagged", () => {
    const { customers } = buildCustomers(serial);
    const risks = codRisks(customers);
    assert.equal(risks.length, 1);
    assert.equal(risks[0].phone, "9111111111");
    assert.equal(risks[0].cancelled, 4);
  });

  test("one cancellation out of one is a bad day, not a pattern", () => {
    // Blocking on a single cancellation loses a customer who may be fine.
    const { customers } = buildCustomers(unlucky);
    assert.deepEqual(codRisks(customers), []);
  });

  test("a prepaid canceller is not a COD risk", () => {
    const prepaid = Array.from({ length: 5 }, (_, i) =>
      o({ id: i + 1, status: "cancelled", paymentMethod: "razorpay", billing: { phone: "9333333333" } }));
    const { customers } = buildCustomers(prepaid);
    assert.deepEqual(codRisks(customers), []);
  });
});

describe("the summary above the list", () => {
  test("repeat buyers are counted and valued separately", () => {
    const { customers } = buildCustomers([
      o({ id: 1, total: "500.00", billing: { phone: "9000000001" } }),
      o({ id: 2, total: "500.00", billing: { phone: "9000000001" } }),
      o({ id: 3, total: "200.00", billing: { phone: "9000000002" } }),
    ]);
    const s = customerSummary(customers);
    assert.equal(s.total, 2);
    assert.equal(s.repeat, 1);
    assert.equal(s.repeatShare, 50);
    assert.equal(s.averageRepeatLifetime, 1000);
  });

  test("an empty order book produces zeroes, not divisions by zero", () => {
    const { customers, unidentified } = buildCustomers([]);
    assert.deepEqual(customers, []);
    assert.equal(unidentified, 0);
    const s = customerSummary([]);
    assert.equal(s.total, 0);
    assert.equal(s.averageLifetime, 0);
    assert.equal(s.repeatShare, 0);
  });
});
