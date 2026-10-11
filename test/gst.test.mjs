// A tax return is filed on these numbers. The property that matters is that
// the components always add back to the rupee the customer actually paid —
// Amazon's own report for this seller holds that in all 507 shipment rows of
// August 2026, and so must ours.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  splitInclusiveGst, taxBreakdownForOrder, principalRatePct, isIntraState, ORIGIN_STATE,
} from "../gst.js";

// Adding two correct rupee figures in binary floating point can land a
// hair off (0.15 + 0.14 comes out 0.29000000000000004), so compare in paise.
const paise = (n) => Math.round(n * 100);
const sums = (parts, total, msg) =>
  assert.equal(parts.reduce((s, n) => s + paise(n), 0), paise(total), msg);

describe("carving GST out of an inclusive price", () => {
  test("a Haryana sale splits into CGST and SGST", () => {
    const r = splitInclusiveGst({ gross: 285, ratePct: 5, shipToState: "Haryana" });
    sums([r.net, r.tax], 285, "net and tax must add back to what was collected");
    sums([r.cgst, r.sgst], r.tax);
    assert.equal(r.igst, 0);
    // Half each, give or take the odd paisa an uneven tax cannot split.
    assert.ok(Math.abs(paise(r.cgst) - paise(r.sgst)) <= 1, "an intra-state split is half each");
  });

  test("a sale to another state is IGST only", () => {
    const r = splitInclusiveGst({ gross: 1080, ratePct: 5, shipToState: "Maharashtra" });
    sums([r.net, r.tax], 1080);
    assert.equal(r.igst, r.tax);
    assert.equal(r.cgst, 0);
    assert.equal(r.sgst, 0);
  });

  test("tax is carved out, never added on top", () => {
    // The customer pays the shelf price. 500 inclusive of 5% is not 525.
    const r = splitInclusiveGst({ gross: 500, ratePct: 5, shipToState: "Delhi" });
    assert.equal(r.gross, 500);
    assert.ok(r.net < 500);
  });

  test("components reconcile at every rupee from 1 to 2000, at both rates", () => {
    // The paisa-drift bug only appears on specific amounts, so sweep them.
    for (const ratePct of [5, 12, 18]) {
      for (const state of ["Haryana", "Kerala"]) {
        for (let gross = 1; gross <= 2000; gross += 1) {
          const r = splitInclusiveGst({ gross, ratePct, shipToState: state });
          sums([r.net, r.tax], gross, `net+tax at ₹${gross} @${ratePct}% ${state}`);
          sums([r.cgst, r.sgst, r.igst], r.tax, `components at ₹${gross} @${ratePct}% ${state}`);
        }
      }
    }
  });

  test("half-paisa splits still sum exactly", () => {
    // 13.57 halved is 6.785 — the pair must still make 13.57, not 13.58.
    for (let p = 1; p <= 400; p += 1) {
      const r = splitInclusiveGst({ gross: p / 4, ratePct: 5, shipToState: "Haryana" });
      sums([r.cgst, r.sgst], r.tax, `at ₹${p / 4}`);
    }
  });

  test("a zero-rated or free line is left alone", () => {
    assert.deepEqual(
      splitInclusiveGst({ gross: 0, ratePct: 5, shipToState: "Haryana" }),
      { gross: 0, net: 0, tax: 0, cgst: 0, sgst: 0, igst: 0, ratePct: 5, intraState: true },
    );
    const free = splitInclusiveGst({ gross: 100, ratePct: 0, shipToState: "Haryana" });
    assert.equal(free.tax, 0);
    assert.equal(free.net, 100);
  });

  test("the origin state is matched however it is written", () => {
    for (const s of ["Haryana", "HARYANA", " haryana ", "Haryana."]) {
      assert.equal(isIntraState(s), true, s);
    }
    assert.equal(isIntraState("Himachal Pradesh"), false);
    assert.equal(isIntraState(""), false);
    assert.equal(ORIGIN_STATE, "HARYANA");
  });
});

describe("the rate a delivery or COD charge carries", () => {
  test("it follows the goods, not a service rate of its own", () => {
    assert.equal(principalRatePct([{ gross: 500, ratePct: 5 }]), 5);
  });

  test("with mixed rates it follows the highest-value line", () => {
    // Composite supply: the bundle takes the principal supply's rate.
    assert.equal(principalRatePct([{ gross: 100, ratePct: 18 }, { gross: 900, ratePct: 5 }]), 5);
    assert.equal(principalRatePct([{ gross: 900, ratePct: 18 }, { gross: 100, ratePct: 5 }]), 18);
  });

  test("an order with nothing priced taxes its charges at nothing", () => {
    // Better no tax than a guessed rate on a filing document.
    assert.equal(principalRatePct([]), 0);
    assert.equal(principalRatePct([{ gross: 0, ratePct: 5 }]), 0);
  });
});

describe("a whole order", () => {
  const order = {
    lines: [{ description: "Ashwagandha Churna", hsn: "3004", sku: "A1", qty: 2, gross: 638, ratePct: 5 }],
    shippingGross: 54,
    shipToState: "Haryana",
  };

  test("the ₹36 COD fee is treated as tax-inclusive at the order's own rate", () => {
    const r = taxBreakdownForOrder({ ...order, codFeeGross: 36, orderTotal: 728 });
    assert.equal(r.codFee.gross, 36, "the customer still pays exactly ₹36");
    assert.ok(r.codFee.tax > 0, "and part of it is tax");
    sums([r.codFee.net, r.codFee.tax], 36);
    assert.equal(r.codFee.ratePct, 5, "the COD fee follows the goods rate");
  });

  test("the whole invoice reconciles to the order total", () => {
    const r = taxBreakdownForOrder({ ...order, codFeeGross: 36, orderTotal: 728 });
    assert.equal(r.totals.gross, 728);
    sums([r.totals.net, r.totals.tax], 728);
    assert.equal(r.reconciles, true);
    assert.equal(r.difference, 0);
  });

  test("a total that does not add up is reported, not hidden", () => {
    // A charge nobody accounted for must surface, not silently skew a return.
    const r = taxBreakdownForOrder({ ...order, codFeeGross: 36, orderTotal: 900 });
    assert.equal(r.reconciles, false);
    assert.equal(r.difference, -172);
  });

  test("delivery is taxed at the goods rate too", () => {
    const r = taxBreakdownForOrder({ ...order, codFeeGross: 0, orderTotal: 692 });
    assert.equal(r.shipping.gross, 54);
    assert.equal(r.shipping.ratePct, 5);
    sums([r.shipping.cgst, r.shipping.sgst], r.shipping.tax);
  });

  test("an out-of-state order puts everything in IGST", () => {
    const r = taxBreakdownForOrder({ ...order, shipToState: "Tamil Nadu", codFeeGross: 36, orderTotal: 728 });
    assert.equal(r.totals.cgst, 0);
    assert.equal(r.totals.sgst, 0);
    assert.equal(r.totals.igst, r.totals.tax);
    assert.equal(r.intraState, false);
  });

  test("a prepaid order carries no COD fee and still reconciles", () => {
    const r = taxBreakdownForOrder({ ...order, codFeeGross: 0, orderTotal: 692 });
    assert.equal(r.codFee.tax, 0);
    assert.equal(r.totals.gross, 692);
    assert.equal(r.reconciles, true);
  });
});
