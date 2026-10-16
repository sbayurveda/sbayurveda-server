// Customers exist only as a pattern across orders — there are no accounts.
// The number that earns the screen is the cancellation rate per phone: COD
// cancels at 27.5% against 1.8% prepaid, and that cost sits on a few numbers.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildCustomers, phoneKey, codRisks, customerSummary, filterCustomers, statesPresent } from "../customers.js";

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

describe("narrowing the customer list", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse("2026-10-16T00:00:00Z");
  const ago = (days) => new Date(NOW - days * DAY).toISOString();

  // Six customers chosen so that every filter below excludes someone, and no
  // two filters would pick out the same set by accident.
  const ROWS = [
    { phone: "9000000001", name: "Asha",   email: "", city: "Gurgaon", state: "Haryana",     orders: 6, placed: 6, cancelled: 0, lifetimeValue: 9400, pays: "prepaid", repeat: true,  codBlocked: false, lastOrderAt: ago(3) },
    { phone: "9000000002", name: "Bhavin", email: "", city: "Mumbai",  state: "Maharashtra", orders: 1, placed: 1, cancelled: 0, lifetimeValue: 640,  pays: "cod",     repeat: false, codBlocked: false, lastOrderAt: ago(20) },
    { phone: "9000000003", name: "Chitra", email: "", city: "Chennai", state: "Tamil Nadu",  orders: 2, placed: 7, cancelled: 5, lifetimeValue: 1800, pays: "cod",     repeat: true,  codBlocked: true,  lastOrderAt: ago(200) },
    { phone: "9000000004", name: "Deepak", email: "", city: "Gurgaon", state: "Haryana",     orders: 3, placed: 3, cancelled: 0, lifetimeValue: 2200, pays: "mixed",   repeat: true,  codBlocked: false, lastOrderAt: ago(95) },
    { phone: "9000000005", name: "Esha",   email: "", city: "Pune",    state: "Maharashtra", orders: 0, placed: 2, cancelled: 2, lifetimeValue: 0,    pays: "cod",     repeat: false, codBlocked: false, lastOrderAt: ago(400) },
    { phone: "9000000006", name: "Farid",  email: "", city: "Delhi",   state: "Delhi",       orders: 4, placed: 4, cancelled: 0, lifetimeValue: 2200, pays: "prepaid", repeat: true,  codBlocked: false, lastOrderAt: null },
  ];

  const names = (query, opts = {}) =>
    filterCustomers(ROWS, query, { now: NOW, ...opts }).map((c) => c.name);

  test("no filters returns everyone", () => {
    assert.equal(filterCustomers(ROWS, {}, { now: NOW }).length, 6);
  });

  test("a cleared box is not a filter of zero", () => {
    // The bug this guards: an empty input arriving as "" and being read as 0,
    // which would exclude nobody on a minimum but everybody on a maximum.
    assert.equal(names({ minValue: "", maxValue: "", minOrders: "", state: "" }).length, 6);
    assert.equal(names({ maxValue: "" }).length, 6);
  });

  test("lifetime value filters on money actually received", () => {
    assert.deepEqual(names({ minValue: 2200 }), ["Asha", "Deepak", "Farid"]);
    assert.deepEqual(names({ maxValue: 1800 }), ["Bhavin", "Chitra", "Esha"]);
    // Inclusive at both ends, so a customer on the boundary appears in both.
    assert.deepEqual(names({ minValue: 2200, maxValue: 2200 }), ["Deepak", "Farid"]);
  });

  test("order count counts kept orders, not attempts", () => {
    // Chitra placed seven and kept two; she is a two-order customer.
    assert.deepEqual(names({ minOrders: 4 }), ["Asha", "Farid"]);
    assert.deepEqual(names({ maxOrders: 1 }), ["Bhavin", "Esha"]);
  });

  test("cancellations can be filtered on their own", () => {
    assert.deepEqual(names({ minCancelled: 2 }), ["Chitra", "Esha"]);
  });

  test("recency finds who to look after", () => {
    assert.deepEqual(names({ activeWithin: 30 }), ["Asha", "Bhavin"]);
  });

  test("dormancy finds who to win back, including anyone with no order date", () => {
    // Farid has no last-order date at all; a customer we cannot date is not
    // recently active, so leaving him out would hide him from both filters.
    assert.deepEqual(names({ dormantFor: 180 }), ["Chitra", "Esha", "Farid"]);
  });

  test("state narrows to one place", () => {
    assert.deepEqual(names({ state: "Maharashtra" }), ["Bhavin", "Esha"]);
    assert.deepEqual(names({ state: "Haryana" }), ["Asha", "Deepak"]);
  });

  test("filters combine instead of overriding each other", () => {
    // The failure worth testing for: a new filter that works alone but drops
    // the ones before it.
    // Haryana alone is Asha and Deepak; the ceiling has to remove Asha's 9400.
    assert.deepEqual(names({ state: "Haryana", maxValue: 3000 }), ["Deepak"]);
    assert.deepEqual(names({ state: "Haryana", minValue: 3000 }), ["Asha"]);
    assert.deepEqual(names({ pays: "cod", minCancelled: 2 }), ["Chitra", "Esha"]);
    assert.deepEqual(names({ q: "gurgaon", maxOrders: 3 }), ["Deepak"]);
    assert.deepEqual(names({ repeat: "true", dormantFor: 180 }), ["Chitra", "Farid"]);
    assert.deepEqual(names({ blocked: "true", state: "Tamil Nadu" }), ["Chitra"]);
  });

  test("the existing text, payment and risk filters still apply", () => {
    assert.deepEqual(names({ q: "9000000002" }), ["Bhavin"]);
    assert.deepEqual(names({ pays: "mixed" }), ["Deepak"]);
    assert.deepEqual(
      names({ risk: "true" }, { risky: new Set(["9000000003"]) }),
      ["Chitra"],
    );
  });

  test("the states offered are the ones customers are actually in", () => {
    assert.deepEqual(statesPresent(ROWS), ["Delhi", "Haryana", "Maharashtra", "Tamil Nadu"]);
  });

  test("an impossible range returns nobody rather than everybody", () => {
    assert.deepEqual(names({ minValue: 5000, maxValue: 100 }), []);
  });
});
