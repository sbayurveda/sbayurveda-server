import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildInvoice, amountInWords } from "../invoice.js";
import { orderToMtrRows } from "../mtr.js";

const order = (over = {}) => ({
  id: 9001,
  number: "12345",
  status: "completed",
  total: "1080.00",
  dateCreated: "2026-09-30T18:40:00",
  datePaid: "2026-10-02T09:00:00",
  paymentMethod: "cod",
  paymentMethodTitle: "Cash on delivery",
  billing: { first_name: "Asha", last_name: "Mehta", address_1: "12 Rose Lane",
             city: "Mumbai", state: "Maharashtra", postcode: "400001", phone: "9811000001" },
  shipping: { address_1: "12 Rose Lane", city: "Mumbai", state: "Maharashtra", postcode: "400001" },
  lineItems: [
    { productId: 1, name: "Ashwagandha Churna 100g", sku: "A1", qty: 2, total: "800.00", totalTax: "40.00" },
    { productId: 2, name: "Triphala Tablets", sku: "T1", qty: 1, total: "194.29", totalTax: "9.71" },
  ],
  feeLines: [{ name: "COD fee", total: "34.29", totalTax: "1.71" }],
  shippingTotal: "0", shippingTax: "0", discountTotal: "0", couponLines: [], refunds: [],
  ...over,
});

describe("rupees in words", () => {
  test("groups the Indian way, not in millions", () => {
    assert.equal(amountInWords(120000), "One Lakh Twenty Thousand Rupees Only");
    assert.equal(amountInWords(10000000), "One Crore Rupees Only");
    assert.equal(amountInWords(1234567), "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Rupees Only");
  });

  test("paise are spelled out only when there are any", () => {
    assert.equal(amountInWords(715), "Seven Hundred Fifteen Rupees Only");
    assert.equal(amountInWords(715.5), "Seven Hundred Fifteen Rupees and Fifty Paise Only");
    assert.equal(amountInWords(0), "Zero Rupees Only");
  });

  test("a credit note reads as a minus", () => {
    assert.match(amountInWords(-500), /^Minus /);
  });
});

describe("the invoice a claim rests on", () => {
  test("it adds up to what the customer was charged", () => {
    const inv = buildInvoice(order());
    assert.equal(inv.reconciles, true, `off by ${inv.difference}`);
    assert.equal(inv.totals.grand, 1080);
  });

  test("taxable plus tax equals the grand total, exactly", () => {
    const inv = buildInvoice(order());
    assert.equal(inv.totals.taxable + inv.totals.tax, inv.totals.grand);
    assert.equal(inv.totals.cgst + inv.totals.sgst + inv.totals.igst, inv.totals.tax);
  });

  test("it agrees with the GST return line for line", () => {
    // The whole point: the invoice is built from the same rows that are filed,
    // so the tax on the document cannot drift from the tax in the return.
    const o = order();
    const rows = orderToMtrRows(o);
    const inv = buildInvoice(o);
    const filedTax = rows.reduce((s, r) =>
      s + r["Cgst Tax"] + r["Sgst Tax"] + r["Igst Tax"]
        + r["Shipping Cgst Tax"] + r["Shipping Sgst Tax"] + r["Shipping Igst Tax"], 0);
    assert.equal(inv.totals.tax, Math.round((filedTax + Number.EPSILON) * 100) / 100);
  });

  test("a sale outside Haryana is IGST, with no CGST or SGST", () => {
    const inv = buildInvoice(order());
    assert.equal(inv.intraState, false);
    assert.ok(inv.totals.igst > 0);
    assert.equal(inv.totals.cgst, 0);
    assert.equal(inv.totals.sgst, 0);
  });

  test("a sale inside Haryana splits into CGST and SGST", () => {
    const inv = buildInvoice(order({
      billing: { ...order().billing, state: "Haryana" },
      shipping: { ...order().shipping, state: "Haryana" },
    }));
    assert.equal(inv.intraState, true);
    assert.equal(inv.totals.igst, 0);
    assert.ok(inv.totals.cgst > 0 && inv.totals.sgst > 0);
    assert.equal(inv.totals.cgst + inv.totals.sgst, inv.totals.tax);
  });

  test("the delivery charge is its own line, not hidden in the first product", () => {
    const inv = buildInvoice(order());
    assert.ok(inv.charges, "the COD fee should appear as a charge line");
    assert.ok(inv.charges.total > 0);
    // And it must not have been folded into a product line as well.
    assert.equal(inv.lines.length, 2);
  });

  test("an order with no charges has no charge line at all", () => {
    const inv = buildInvoice(order({ feeLines: [], total: "1044.00" }));
    assert.equal(inv.charges, null);
  });

  test("the invoice date is the order date, not the payment date", () => {
    // A COD order paid on delivery would otherwise carry next month's date and
    // land in the wrong return.
    assert.equal(buildInvoice(order()).invoiceDate, "2026-09-30");
  });

  test("an order with nothing on it is refused rather than invoiced blank", () => {
    assert.throws(() => buildInvoice(order({ lineItems: [] })), /no items to invoice/);
  });

  test("a mismatch is reported rather than hidden", () => {
    const inv = buildInvoice(order({ total: "999.00" }));
    assert.equal(inv.reconciles, false);
    assert.ok(Math.abs(inv.difference) > 0.01);
  });

  test("the buyer and place of supply come off the order", () => {
    const inv = buildInvoice(order());
    assert.equal(inv.buyer.name, "Asha Mehta");
    assert.equal(inv.placeOfSupply, "Maharashtra");
    assert.equal(inv.seller.gstin, "06ISBPK6890P1ZU");
    assert.equal(inv.payment.isCod, true);
  });
});

describe("the ship-to block", () => {
  test("borrows the buyer's name when the shipping address has none", () => {
    // WooCommerce shipping addresses usually carry no name, and a blank first
    // line reads as missing data on a document someone has to act on.
    const inv = buildInvoice(order());
    assert.equal(inv.buyer.shipping.name, "Asha Mehta");
  });

  test("keeps a shipping name of its own when there is one", () => {
    const inv = buildInvoice(order({
      shipping: { first_name: "Ravi", last_name: "Kumar", address_1: "9 Other Road",
                  city: "Pune", state: "Maharashtra", postcode: "411001" },
    }));
    assert.equal(inv.buyer.shipping.name, "Ravi Kumar");
    assert.equal(inv.buyer.name, "Asha Mehta");
  });

  test("falls back to the billing address when there is no shipping one", () => {
    const inv = buildInvoice(order({ shipping: {} }));
    assert.equal(inv.buyer.shipping.city, "Mumbai");
  });
});

describe("what an invoice is expected to add up to", () => {
  test("a cancelled order reconciles at zero, not at its face value", () => {
    // A cancellation collected nothing. Flagging it as a mismatch would put a
    // red warning on every cancelled order and teach people to ignore it.
    const inv = buildInvoice(order({ status: "cancelled" }));
    assert.equal(inv.transactionType, "Cancel");
    assert.equal(inv.totals.grand, 0);
    assert.equal(inv.reconciles, true);
    assert.equal(inv.difference, 0);
  });

  test("a refund reconciles against the negative of the order", () => {
    const inv = buildInvoice(order({ status: "refunded" }));
    assert.equal(inv.transactionType, "Refund");
    assert.ok(inv.totals.grand < 0, `expected a credit, got ${inv.totals.grand}`);
    assert.equal(inv.reconciles, true);
  });

  test("a genuine mismatch on a live order is still reported", () => {
    const inv = buildInvoice(order({ total: "999.00" }));
    assert.equal(inv.reconciles, false);
  });
});
