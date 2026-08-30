// Reconciliation is the safety net that catches a payment nobody noticed was
// stranded. These tests cover the calculation itself, without a network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findOrphanedPayments, summariseReconciliation } from "../reconcile.js";

const payment = (id, orderId, amount, extra = {}) => ({
  id,
  order_id: orderId,
  amount: amount * 100,
  status: "captured",
  method: "upi",
  created_at: 1756000000,
  ...extra,
});

describe("finding paid transactions with no order", () => {
  test("a payment already on an order is not flagged", () => {
    const orphans = findOrphanedPayments({
      capturedPayments: [payment("pay_1", "order_1", 500)],
      bookedPaymentIds: new Set(["pay_1"]),
    });
    assert.equal(orphans.length, 0);
  });

  test("a payment with no matching order is flagged", () => {
    const orphans = findOrphanedPayments({
      capturedPayments: [payment("pay_1", "order_1", 500, { email: "a@b.com", contact: "9876543210" })],
      bookedPaymentIds: new Set(),
      hasSavedCart: () => true,
    });

    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].paymentId, "pay_1");
    assert.equal(orphans[0].amount, 500, "amount is reported in rupees, not paise");
    assert.equal(orphans[0].email, "a@b.com");
    assert.equal(orphans[0].recoverable, true);
  });

  test("only the unbooked ones are picked out of a mixed batch", () => {
    const orphans = findOrphanedPayments({
      capturedPayments: [
        payment("pay_ok1", "order_a", 100),
        payment("pay_lost", "order_b", 250),
        payment("pay_ok2", "order_c", 300),
      ],
      bookedPaymentIds: new Set(["pay_ok1", "pay_ok2"]),
      hasSavedCart: () => true,
    });

    assert.deepEqual(orphans.map((o) => o.paymentId), ["pay_lost"]);
  });

  test("a payment with no saved cart is reported for manual entry, not guessed", () => {
    // The gateway only records an amount — rebuilding a cart from that would be
    // inventing an order.
    const orphans = findOrphanedPayments({
      capturedPayments: [payment("pay_old", "order_old", 406)],
      bookedPaymentIds: new Set(),
      hasSavedCart: () => false,
    });

    assert.equal(orphans[0].recoverable, false);
    assert.match(orphans[0].reason, /by hand/);
  });

  test("recoverable and unrecoverable are distinguished in one batch", () => {
    const orphans = findOrphanedPayments({
      capturedPayments: [payment("pay_new", "order_new", 137), payment("pay_old", "order_old", 406)],
      bookedPaymentIds: new Set(),
      hasSavedCart: (orderId) => orderId === "order_new",
    });

    assert.equal(orphans.filter((o) => o.recoverable).length, 1);
    assert.equal(orphans.filter((o) => !o.recoverable).length, 1);
  });
});

describe("reconciliation summary", () => {
  test("counts and totals the money at risk", () => {
    const captured = [
      payment("pay_1", "o1", 100),
      payment("pay_2", "o2", 250.5),
      payment("pay_3", "o3", 300),
    ];
    const orphans = findOrphanedPayments({
      capturedPayments: captured,
      bookedPaymentIds: new Set(["pay_1"]),
      hasSavedCart: () => true,
    });

    assert.deepEqual(summariseReconciliation(captured, orphans), {
      capturedPayments: 3,
      alreadyBooked: 1,
      orphaned: 2,
      orphanedValue: 550.5,
    });
  });

  test("a clean day reports nothing outstanding", () => {
    const captured = [payment("pay_1", "o1", 100)];
    const orphans = findOrphanedPayments({
      capturedPayments: captured,
      bookedPaymentIds: new Set(["pay_1"]),
    });
    assert.equal(summariseReconciliation(captured, orphans).orphaned, 0);
    assert.equal(summariseReconciliation(captured, orphans).orphanedValue, 0);
  });
});
