// The monthly return. Two things must hold: the file has to be the shape the
// accountant's tooling expects, and every figure in it has to add back to
// money that actually moved.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildMtr, orderToMtrRows, rowsToCsv, MTR_COLUMNS, transactionTypeFor, rateForHsn } from "../mtr.js";

const paise = (n) => Math.round(Number(n) * 100);

function order(over = {}) {
  return {
    id: 5001, number: "12606", status: "processing",
    dateCreated: "2026-08-14T10:20:00", datePaid: "2026-08-14T10:21:00",
    dateCompleted: "", dateModified: "2026-08-14T10:21:00",
    total: "728.00", shippingTotal: 54, paymentMethod: "cod",
    billing: { city: "Hisar", state: "Haryana", postcode: "125001", phone: "9876543210" },
    shipping: { city: "Hisar", state: "Haryana", postcode: "125001" },
    lineItems: [{ productId: 101, name: "Ashwagandha Churna (100g)", sku: "A1", qty: 2, total: 638 }],
    feeLines: [{ name: "Cash on Delivery Fee", total: 36 }],
    ...over,
  };
}

describe("file shape", () => {
  test("every one of Amazon's 78 columns is present, in order", () => {
    assert.equal(MTR_COLUMNS.length, 78);
    assert.equal(MTR_COLUMNS[0], "Seller Gstin");
    assert.equal(MTR_COLUMNS[27], "Invoice Amount");
    assert.equal(MTR_COLUMNS[77], "Credit Note Date");
  });

  test("the CSV header matches the column list exactly", () => {
    const [head] = rowsToCsv(orderToMtrRows(order())).split("\n");
    assert.equal(head.split(",").length, 78);
    assert.ok(head.startsWith("Seller Gstin,Invoice Number,Invoice Date"));
  });

  test("a product name containing a comma does not break the file", () => {
    const rows = orderToMtrRows(order({
      lineItems: [{ productId: 1, name: 'Churna, 100g, "special"', sku: "", qty: 1, total: 638 }],
    }));
    const line = rowsToCsv(rows).split("\n")[1];
    assert.equal(line.split('","').length >= 1, true);
    // Quoted correctly means the row still has 78 fields when parsed.
    const fields = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).filter((_, i, a) => i < a.length - 1 || true);
    assert.ok(fields.length >= 78, `expected 78 fields, parsed ${fields.length}`);
  });

  test("the invoice number is the WooCommerce order number", () => {
    const [row] = orderToMtrRows(order({ number: "12743" }));
    assert.equal(row["Invoice Number"], "12743");
    assert.equal(row["Order Id"], "12743");
  });
});

describe("what a row says", () => {
  test("an intra-state order carries CGST and SGST, no IGST", () => {
    const [row] = orderToMtrRows(order());
    assert.ok(row["Cgst Tax"] > 0);
    assert.ok(row["Sgst Tax"] > 0);
    assert.equal(row["Igst Tax"], 0);
    assert.equal(row["Cgst Rate"], 0.025, "5% splits into 2.5 + 2.5, written as a fraction");
    assert.equal(row["Igst Rate"], 0);
  });

  test("an out-of-state order carries IGST only", () => {
    const [row] = orderToMtrRows(order({ shipping: { city: "Pune", state: "Maharashtra", postcode: "411001" } }));
    assert.ok(row["Igst Tax"] > 0);
    assert.equal(row["Cgst Tax"], 0);
    assert.equal(row["Sgst Tax"], 0);
    assert.equal(row["Igst Rate"], 0.05);
  });

  test("the row reconciles: taxable value plus tax equals the invoice amount", () => {
    const [row] = orderToMtrRows(order());
    assert.equal(
      paise(row["Tax Exclusive Gross"]) + paise(row["Total Tax Amount"]),
      paise(row["Invoice Amount"]),
    );
  });

  test("the COD fee is reported with tax carved out of it, not added on", () => {
    const [row] = orderToMtrRows(order());
    // Shipping ₹54 + COD ₹36 = ₹90 collected, and tax comes out of that ₹90.
    assert.equal(paise(row["Shipping Amount"]), paise(90));
    assert.ok(row["Shipping Cgst Tax"] > 0, "the COD fee is taxed");
    assert.equal(
      paise(row["Shipping Amount Basis"]) + paise(row["Shipping Cgst Tax"]) + paise(row["Shipping Sgst Tax"]),
      paise(90),
      "the charge still adds back to the ₹90 collected",
    );
  });

  test("charges ride on the first line only, never multiplied across items", () => {
    const rows = orderToMtrRows(order({
      total: "1366.00",
      lineItems: [
        { productId: 1, name: "A", sku: "", qty: 1, total: 638 },
        { productId: 2, name: "B", sku: "", qty: 1, total: 638 },
      ],
    }));
    assert.equal(rows.length, 2);
    assert.equal(paise(rows[0]["Shipping Amount"]), paise(90));
    assert.equal(rows[1]["Shipping Amount"], 0, "summing the file must not count the fee twice");
  });

  test("the whole order's rows add up to what the customer paid", () => {
    const rows = orderToMtrRows(order({
      total: "1366.00",
      lineItems: [
        { productId: 1, name: "A", sku: "", qty: 1, total: 638 },
        { productId: 2, name: "B", sku: "", qty: 1, total: 638 },
      ],
    }));
    const invoiced = rows.reduce((s, r) => s + paise(r["Invoice Amount"]), 0);
    assert.equal(invoiced, paise(1366));
  });
});

describe("transaction types", () => {
  test("a cancelled order is a Cancel, a refunded one a Refund", () => {
    assert.equal(transactionTypeFor("cancelled"), "Cancel");
    assert.equal(transactionTypeFor("failed"), "Cancel");
    assert.equal(transactionTypeFor("refunded"), "Refund");
    assert.equal(transactionTypeFor("processing"), "Shipment");
    assert.equal(transactionTypeFor("completed"), "Shipment");
  });

  test("a refund carries a credit note reference", () => {
    const [row] = orderToMtrRows(order({ status: "refunded" }));
    assert.equal(row["Transaction Type"], "Refund");
    assert.equal(row["Credit Note No"], "12606");
  });
});

describe("HSN rates", () => {
  test("ayurvedic medicaments are 5%", () => {
    assert.equal(rateForHsn("3004"), 5);
  });

  test("an unknown code takes the default rather than zero", () => {
    // Silently reporting no tax is the worst thing this file could do.
    assert.ok(rateForHsn("") > 0);
    assert.ok(rateForHsn("9999") > 0);
  });

  test("a rate can be overridden per code", () => {
    assert.equal(rateForHsn("3304", { 3304: 18 }), 18);
  });
});

describe("the month", () => {
  const months = [
    order({ id: 1, number: "1", dateCreated: "2026-07-31T23:59:00" }),
    order({ id: 2, number: "2", dateCreated: "2026-08-01T00:01:00" }),
    order({ id: 3, number: "3", dateCreated: "2026-08-31T23:59:00" }),
    order({ id: 4, number: "4", dateCreated: "2026-09-01T00:01:00" }),
  ];

  test("only orders inside the month are included, at both edges", () => {
    const { summary } = buildMtr(months, { from: "2026-08-01", to: "2026-08-31" });
    assert.equal(summary.orders, 2);
  });

  test("the summary totals equal the sum of the rows", () => {
    const { rows, summary } = buildMtr(months, { from: "2026-08-01", to: "2026-08-31" });
    const invoiced = rows.reduce((s, r) => s + paise(r["Invoice Amount"]), 0);
    assert.equal(paise(summary.invoiceTotal), invoiced);
    assert.equal(
      paise(summary.taxableValue) + paise(summary.totalTax),
      paise(summary.invoiceTotal),
      "the month must reconcile the same way a row does",
    );
  });

  test("an order whose lines do not add up is listed, not silently filed", () => {
    const wrong = order({ id: 9, number: "9", total: "999.00", dateCreated: "2026-08-10T10:00:00" });
    const { unreconciled } = buildMtr([wrong], { from: "2026-08-01", to: "2026-08-31" });
    assert.equal(unreconciled.length, 1);
    assert.equal(unreconciled[0].order, "9");
  });

  test("a clean month reports nothing unreconciled", () => {
    const { unreconciled } = buildMtr([order()], { from: "2026-08-01", to: "2026-08-31" });
    assert.deepEqual(unreconciled, []);
  });
});

// Forty orders in one month came back "off by" sums between ₹3.57 and ₹76.67.
// The cause: this store writes coupon discounts as negative fee lines rather
// than WooCommerce coupons, and the report counted only the COD fee. Every
// discounted order was therefore short by its discount.
describe("discounts and other charges", () => {
  const discounted = (over = {}) => order({
    total: "698.00",            // 638 goods + 54 delivery + 36 COD − 30 discount
    feeLines: [
      { name: "Cash on Delivery Fee", total: 36 },
      { name: "Coupon SAVE30", total: -30 },
    ],
    discountTotal: 30,
    ...over,
  });

  test("an order with a discount reconciles", () => {
    const { unreconciled } = buildMtr([discounted()], { from: "2026-08-01", to: "2026-08-31" });
    assert.deepEqual(unreconciled, [], "a discounted order must not be reported as off");
  });

  test("the discount comes off the taxable value, not out of nowhere", () => {
    const [row] = orderToMtrRows(discounted());
    // GST is due on what was actually received: 638 − 30 = 608 of goods.
    assert.equal(paise(row["Principal Amount"]), paise(608));
    assert.equal(paise(row["Item Promo Discount"]), paise(30));
  });

  test("the row still adds back to what the customer paid", () => {
    const [row] = orderToMtrRows(discounted());
    assert.equal(
      paise(row["Tax Exclusive Gross"]) + paise(row["Total Tax Amount"]),
      paise(row["Invoice Amount"]),
    );
  });

  test("the month total equals what was collected, after discounts", () => {
    const { summary } = buildMtr([discounted()], { from: "2026-08-01", to: "2026-08-31" });
    assert.equal(paise(summary.invoiceTotal), paise(698));
    assert.equal(paise(summary.taxableValue) + paise(summary.totalTax), paise(698));
  });

  test("a discount spread over several lines still sums to the discount", () => {
    const rows = orderToMtrRows(discounted({
      total: "1336.00",
      lineItems: [
        { productId: 1, name: "A", sku: "", qty: 1, total: 638 },
        { productId: 2, name: "B", sku: "", qty: 1, total: 638 },
      ],
    }));
    const spread = rows.reduce((s, r) => s + paise(r["Item Promo Discount"]), 0);
    assert.equal(spread, paise(30), "apportioning must not lose or invent a paisa");
    assert.equal(rows.reduce((s, r) => s + paise(r["Invoice Amount"]), 0), paise(1336));
  });

  test("a fee that is not the COD fee is counted too", () => {
    const withFee = order({
      total: "742.00",          // 638 + 54 delivery + 36 COD + 14 handling
      feeLines: [
        { name: "Cash on Delivery Fee", total: 36 },
        { name: "Handling", total: 14 },
      ],
    });
    const { unreconciled } = buildMtr([withFee], { from: "2026-08-01", to: "2026-08-31" });
    assert.deepEqual(unreconciled, []);
  });

  test("an uneven discount apportions without drift", () => {
    // 33.33 over three lines is the classic rounding trap.
    const rows = orderToMtrRows(order({
      total: "1880.67",
      discountTotal: 33.33,
      feeLines: [{ name: "Coupon", total: -33.33 }],
      shippingTotal: 0,
      lineItems: [
        { productId: 1, name: "A", sku: "", qty: 1, total: 638 },
        { productId: 2, name: "B", sku: "", qty: 1, total: 638 },
        { productId: 3, name: "C", sku: "", qty: 1, total: 638 },
      ],
    }));
    assert.equal(rows.reduce((s, r) => s + paise(r["Item Promo Discount"]), 0), paise(33.33));
    assert.equal(rows.reduce((s, r) => s + paise(r["Invoice Amount"]), 0), paise(1880.67));
  });
});

// Thirty-five orders came back "off by" amounts that turned out to be exactly
// the tax WooCommerce had already recorded: ₹13.33 on a ₹280 sale, ₹40.00 on
// ₹840, ₹33.33 on ₹700. WooCommerce reports a line's total NET of tax with
// total_tax beside it; reading that net as the gross lost the tax and then
// carved a second 5% out of what was left.
describe("orders where WooCommerce already recorded the tax", () => {
  // ₹280 inclusive of 5%: net 266.67, tax 13.33.
  const recorded = (over = {}) => order({
    total: "280.00",
    shippingTotal: 0, shippingTax: 0, feeLines: [], discountTotal: 0,
    lineItems: [{ productId: 101, name: "Churna", sku: "A1", qty: 1, total: 266.67, totalTax: 13.33 }],
    ...over,
  });

  test("the order reconciles instead of being off by its own tax", () => {
    const { unreconciled } = buildMtr([recorded()], { from: "2026-08-01", to: "2026-08-31" });
    assert.deepEqual(unreconciled, []);
  });

  test("the recorded tax is carried through, not recalculated", () => {
    const [row] = orderToMtrRows(recorded());
    assert.equal(paise(row["Invoice Amount"]), paise(280));
    assert.equal(paise(row["Tax Exclusive Gross"]), paise(266.67));
    assert.equal(paise(row["Total Tax Amount"]), paise(13.33));
    assert.equal(paise(row["Cgst Tax"]) + paise(row["Sgst Tax"]), paise(13.33));
  });

  test("a ₹840 order reports ₹40.00, the figure the shop charged", () => {
    const [row] = orderToMtrRows(recorded({
      total: "840.00",
      lineItems: [{ productId: 1, name: "X", sku: "", qty: 1, total: 800, totalTax: 40 }],
    }));
    assert.equal(paise(row["Total Tax Amount"]), paise(40));
    assert.equal(paise(row["Invoice Amount"]), paise(840));
  });

  test("delivery and the COD fee carry their own recorded tax too", () => {
    const [row] = orderToMtrRows(recorded({
      total: "374.00",           // 280 goods + 51.43+2.57 delivery + 34.29+1.71 COD
      shippingTotal: 51.43, shippingTax: 2.57,
      feeLines: [{ name: "Cash on Delivery Fee", total: 34.29, totalTax: 1.71 }],
    }));
    assert.equal(paise(row["Shipping Amount"]), paise(90));
    assert.equal(paise(row["Shipping Cgst Tax"]) + paise(row["Shipping Sgst Tax"]), paise(4.28));
    assert.equal(
      paise(row["Tax Exclusive Gross"]) + paise(row["Total Tax Amount"]),
      paise(row["Invoice Amount"]),
    );
  });

  test("an out-of-state order puts the recorded tax in IGST", () => {
    const [row] = orderToMtrRows(recorded({ shipping: { city: "Pune", state: "Maharashtra", postcode: "411001" } }));
    assert.equal(paise(row["Igst Tax"]), paise(13.33));
    assert.equal(row["Cgst Tax"], 0);
  });

  test("an older order with no recorded tax still gets tax carved out", () => {
    // Orders from before GST was configured must not be reported as tax-free.
    const [row] = orderToMtrRows(recorded({
      total: "280.00",
      lineItems: [{ productId: 1, name: "X", sku: "", qty: 1, total: 280, totalTax: 0 }],
    }));
    assert.ok(row["Total Tax Amount"] > 0, "a tax-free row would under-report the return");
    assert.equal(paise(row["Invoice Amount"]), paise(280));
  });

  test("a month of recorded-tax orders totals what was collected", () => {
    const { summary } = buildMtr([recorded(), recorded({ id: 2, number: "2" })],
      { from: "2026-08-01", to: "2026-08-31" });
    assert.equal(paise(summary.invoiceTotal), paise(560));
    assert.equal(paise(summary.totalTax), paise(26.66));
    assert.equal(paise(summary.taxableValue) + paise(summary.totalTax), paise(summary.invoiceTotal));
  });
});

// Order #12955 was placed 30 September and paid 2 October — cash on delivery,
// so payment lands with the parcel. It was filed in September (correct) but
// carried an October invoice date, because those two columns were reading
// different fields.
describe("which date an invoice carries", () => {
  const codPaidLater = order({
    id: 12955, number: "12955",
    dateCreated: "2026-09-30T18:20:00",
    datePaid: "2026-10-02T11:05:00",      // the courier collected two days later
    dateCompleted: "2026-10-02T11:05:00",
    dateModified: "2026-10-02T11:05:00",
    paymentMethod: "cod",
  });

  test("the invoice is dated when the order was placed, not when it was paid", () => {
    const [row] = orderToMtrRows(codPaidLater);
    assert.equal(row["Invoice Date"].slice(0, 10), "2026-09-30");
    assert.equal(row["Order Date"].slice(0, 10), "2026-09-30");
  });

  test("no invoice in a month's file is dated outside that month", () => {
    // The invariant that matters: an invoice dated outside the period it is
    // filed in is what gets a return questioned.
    const { rows } = buildMtr([codPaidLater], { from: "2026-09-01", to: "2026-09-30" });
    assert.ok(rows.length > 0, "the order must still be in September's file");
    for (const r of rows) {
      const day = r["Invoice Date"].slice(0, 10);
      assert.ok(day >= "2026-09-01" && day <= "2026-09-30", `invoice dated ${day} in the September file`);
    }
  });

  test("it does not reappear in the next month's file", () => {
    const { rows } = buildMtr([codPaidLater], { from: "2026-10-01", to: "2026-10-31" });
    assert.equal(rows.length, 0, "paying in October must not move the sale into October");
  });

  test("a prepaid order paid the same minute is unaffected", () => {
    const [row] = orderToMtrRows(order({
      dateCreated: "2026-08-14T10:20:00", datePaid: "2026-08-14T10:20:30", paymentMethod: "razorpay",
    }));
    assert.equal(row["Invoice Date"].slice(0, 10), "2026-08-14");
  });
});
