import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  formatInvoiceNo, parseInvoiceNo, inNewSeries, nextInvoiceSeq, invoiceNoFor,
} from "../invoiceNumber.js";

describe("how an invoice number is written", () => {
  test("it starts at SB00000001", () => {
    assert.equal(formatInvoiceNo(1), "SB00000001");
    assert.equal(formatInvoiceNo(42), "SB00000042");
    assert.equal(formatInvoiceNo(1300), "SB00001300");
  });

  test("it never writes a zero or a negative", () => {
    // There is no invoice zero, and a bad input must not produce one.
    assert.equal(formatInvoiceNo(0), "SB00000001");
    assert.equal(formatInvoiceNo(-5), "SB00000001");
    assert.equal(formatInvoiceNo(null), "SB00000001");
  });

  test("it reads back exactly what it wrote", () => {
    for (const n of [1, 9, 10, 999, 1300, 99999999]) {
      assert.equal(parseInvoiceNo(formatInvoiceNo(n)), n);
    }
  });

  test("an order number is not mistaken for an invoice number", () => {
    // The whole point of the change: 13782 is a post ID, not a serial.
    assert.equal(parseInvoiceNo("13782"), null);
    assert.equal(parseInvoiceNo("SB1378"), null, "too few digits");
    assert.equal(parseInvoiceNo("XX00000001"), null);
    assert.equal(parseInvoiceNo(""), null);
    assert.equal(parseInvoiceNo(null), null);
  });
});

describe("which orders join the new series", () => {
  const on = (date) => ({ dateCreated: `${date}T10:00:00`, number: "9999" });

  test("orders from the cutover day onwards do", () => {
    assert.equal(inNewSeries(on("2026-10-21")), true);
    assert.equal(inNewSeries(on("2026-10-22")), true);
    assert.equal(inNewSeries(on("2027-01-05")), true);
  });

  test("anything earlier does not", () => {
    assert.equal(inNewSeries(on("2026-10-20")), false);
    assert.equal(inNewSeries(on("2026-04-16")), false);
  });

  test("the cutover day counts from its first minute", () => {
    assert.equal(inNewSeries({ dateCreated: "2026-10-21T00:00:01", number: "1" }), true);
    assert.equal(inNewSeries({ dateCreated: "2026-10-20T23:59:59", number: "1" }), false);
  });
});

describe("choosing the next number", () => {
  test("the first invoice of the series is 1", () => {
    assert.equal(nextInvoiceSeq([]), 1);
    assert.equal(nextInvoiceSeq([{ number: "13887" }, { number: "13888" }]), 1);
  });

  test("it follows the highest already issued", () => {
    const orders = [
      { invoiceNo: "SB00000001" },
      { invoiceNo: "SB00000003" },
      { invoiceNo: "SB00000002" },
    ];
    assert.equal(nextInvoiceSeq(orders), 4);
  });

  test("order numbers are ignored when working it out", () => {
    // Otherwise the first invoice would be numbered 13888.
    assert.equal(nextInvoiceSeq([{ number: "13887", invoiceNo: "" }]), 1);
  });

  test("it is taken from the orders themselves, so a gap cannot open", () => {
    // A number is only ever used by being written to an order, so there is
    // no counter that can drift ahead of what was actually issued.
    const issued = [{ invoiceNo: "SB00000001" }, { invoiceNo: "SB00000002" }];
    assert.equal(nextInvoiceSeq(issued), 3);
    issued.push({ invoiceNo: formatInvoiceNo(nextInvoiceSeq(issued)) });
    assert.equal(issued.at(-1).invoiceNo, "SB00000003");
    assert.equal(nextInvoiceSeq(issued), 4);
  });
});

describe("what gets printed on an invoice", () => {
  test("an issued number always wins, so a reprint never changes", () => {
    assert.equal(
      invoiceNoFor({ invoiceNo: "SB00000007", number: "13900", dateCreated: "2026-10-25T00:00:00" }),
      "SB00000007",
    );
  });

  test("an old order keeps the number it was already invoiced under", () => {
    // April's invoice is a document the customer holds and the return
    // carries; reprinting it must not renumber it.
    assert.equal(invoiceNoFor({ number: "7624", dateCreated: "2026-04-16T04:42:43" }), "7624");
    assert.equal(invoiceNoFor({ number: "9116", dateCreated: "2026-06-15T23:42:14" }), "9116");
  });

  test("a new order has no number until one is issued", () => {
    assert.equal(invoiceNoFor({ number: "13900", dateCreated: "2026-10-25T00:00:00" }), "");
  });
});

describe("what the tax export carries", () => {
  const order = (over = {}) => ({
    id: 1, number: "13888", status: "completed", total: "876.00",
    dateCreated: "2026-10-21T08:00:00", paymentMethod: "cod", paymentMethodTitle: "Cash on delivery",
    billing: { first_name: "A", last_name: "B", city: "Madurai", state: "Tamil Nadu", postcode: "625001" },
    shipping: { city: "Madurai", state: "Tamil Nadu", postcode: "625001" },
    lineItems: [{ productId: 1, name: "Churna", sku: "S1", qty: 1, total: "800.00", totalTax: "40.00" }],
    feeLines: [{ name: "COD fee", total: "34.29", totalTax: "1.71" }],
    shippingTotal: "0", discountTotal: "0", couponLines: [], refunds: [],
    ...over,
  });

  test("the invoice number column is the number on the invoice, not the order", async () => {
    // The return has to name the same number as the document it describes.
    const { orderToMtrRows } = await import("../mtr.js");
    const row = orderToMtrRows(order({ invoiceNo: "SB00000001" }))[0];
    assert.equal(row["Invoice Number"], "SB00000001");
  });

  test("the order id column still carries the order number", async () => {
    // Both are needed: one identifies the document, the other the sale.
    const { orderToMtrRows } = await import("../mtr.js");
    const row = orderToMtrRows(order({ invoiceNo: "SB00000001" }))[0];
    assert.equal(row["Order Id"], "13888");
    assert.notEqual(row["Invoice Number"], row["Order Id"]);
  });

  test("an order invoiced before the cutover still exports its old number", async () => {
    const { orderToMtrRows } = await import("../mtr.js");
    const row = orderToMtrRows(order({ number: "7624", dateCreated: "2026-04-16T04:42:43" }))[0];
    assert.equal(row["Invoice Number"], "7624");
    assert.equal(row["Order Id"], "7624");
  });

  test("every line of one order shares its invoice number", async () => {
    const { orderToMtrRows } = await import("../mtr.js");
    const rows = orderToMtrRows(order({
      invoiceNo: "SB00000009",
      lineItems: [
        { productId: 1, name: "A", sku: "S1", qty: 1, total: "400.00", totalTax: "20.00" },
        { productId: 2, name: "B", sku: "S2", qty: 1, total: "400.00", totalTax: "20.00" },
      ],
    }));
    assert.equal(rows.length, 2);
    assert.deepEqual([...new Set(rows.map((r) => r["Invoice Number"]))], ["SB00000009"]);
  });
});
