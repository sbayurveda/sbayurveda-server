// A tax invoice for one order.
//
// Built from orderToMtrRows — the very rows that go into the GST return —
// rather than from a second reading of the order. An invoice that disagrees
// with the filing is worse than no invoice: it is the document a claim is
// assessed against, and the two have to say the same thing to the paisa. So
// the numbers here are not recomputed, only regrouped.

import { orderToMtrRows, SHIP_FROM, rateForHsn, signFor } from "./mtr.js";
import { SELLER_GSTIN, isIntraState } from "./gst.js";

export const SELLER = {
  name: process.env.SELLER_NAME || "SB Ayurveda",
  gstin: SELLER_GSTIN,
  addressLines: (process.env.SELLER_ADDRESS || "Shahbad, Kurukshetra, Haryana 136156")
    .split("|")
    .map((l) => l.trim())
    .filter(Boolean),
  state: SHIP_FROM.state,
  email: process.env.SELLER_EMAIL || "",
  phone: process.env.SELLER_PHONE || "",
};

function round2(n) {
  return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function underThousand(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return (TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "")).trim();
  return (ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + underThousand(n % 100) : "")).trim();
}

/**
 * Rupees in words, grouped the Indian way.
 *
 * A GST invoice carries the amount in words, and in India that means lakh and
 * crore rather than million — "One Lakh Twenty Thousand", not "One Hundred and
 * Twenty Thousand". Paise are spelled out separately when present.
 */
export function amountInWords(amount) {
  const value = Math.abs(round2(amount));
  const rupees = Math.floor(value);
  const paise = Math.round((value - rupees) * 100);
  if (rupees === 0 && paise === 0) return "Zero Rupees Only";

  const parts = [];
  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const rest = rupees % 1000;
  if (crore) parts.push(`${underThousand(crore)} Crore`);
  if (lakh) parts.push(`${underThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${underThousand(thousand)} Thousand`);
  if (rest) parts.push(underThousand(rest));

  const sign = amount < 0 ? "Minus " : "";
  const rupeeWords = parts.length ? `${parts.join(" ")} Rupees` : "Zero Rupees";
  if (!paise) return `${sign}${rupeeWords} Only`;
  return `${sign}${rupeeWords} and ${underThousand(paise)} Paise Only`;
}

function person(addr = {}) {
  const name = [addr.first_name, addr.last_name].filter(Boolean).join(" ").trim();
  return {
    name,
    addressLines: [addr.address_1, addr.address_2].filter(Boolean),
    city: addr.city || "",
    state: addr.state || "",
    postcode: addr.postcode || "",
    phone: addr.phone || "",
    email: addr.email || "",
  };
}

/**
 * Turns one order into a printable tax invoice.
 *
 * Shipping and the cash-on-delivery fee appear as their own line rather than
 * being folded into the first product, because a customer reading the invoice
 * has to be able to see what the delivery charge was — the MTR hides it in the
 * first row only because its format has nowhere else to put it.
 */
export function buildInvoice(order, { hsnByProductId = {}, rateOverrides = {} } = {}) {
  const rows = orderToMtrRows(order, { hsnByProductId, rateOverrides });
  if (!rows.length) {
    throw Object.assign(new Error("That order has no items to invoice."), { status: 400 });
  }

  const shipTo = order.shipping?.state || order.billing?.state || "";
  const intraState = isIntraState(shipTo);

  const lines = rows.map((r) => ({
    description: r["Item Description"],
    hsn: r["Hsn/sac"],
    sku: r.Sku,
    qty: Number(r.Quantity) || 0,
    taxable: round2(r["Principal Amount Basis"]),
    ratePct: rateForHsn(r["Hsn/sac"], rateOverrides),
    cgst: round2(r["Cgst Tax"]),
    sgst: round2(r["Sgst Tax"]),
    igst: round2(r["Igst Tax"]),
    total: round2(r["Principal Amount"]),
  }));

  // The charges ride on the first MTR row; pulled out, they read as their own
  // line on the invoice.
  const first = rows[0];
  const chargeTaxable = round2(first["Shipping Amount Basis"]);
  const chargeTax = round2(
    Number(first["Shipping Cgst Tax"]) + Number(first["Shipping Sgst Tax"]) + Number(first["Shipping Igst Tax"]),
  );
  const charges = chargeTaxable || chargeTax
    ? {
        description: "Delivery & handling",
        hsn: first["Hsn/sac"],
        taxable: chargeTaxable,
        cgst: round2(first["Shipping Cgst Tax"]),
        sgst: round2(first["Shipping Sgst Tax"]),
        igst: round2(first["Shipping Igst Tax"]),
        total: round2(first["Shipping Amount"]),
      }
    : null;

  const sum = (pick) => round2(lines.reduce((s, l) => s + pick(l), 0) + (charges ? pick(charges) : 0));
  const totals = {
    taxable: sum((l) => l.taxable),
    cgst: sum((l) => l.cgst),
    sgst: sum((l) => l.sgst),
    igst: sum((l) => l.igst),
  };
  totals.tax = round2(totals.cgst + totals.sgst + totals.igst);
  totals.grand = round2(totals.taxable + totals.tax);

  // The invoice must add up to what the customer was actually charged. Saying
  // so is the difference between a document a claim can rest on and one that
  // quietly disagrees with the order.
  //
  // What it should add up to depends on the transaction. A cancellation never
  // collected anything, so its figures are zero and zero is correct; a refund
  // reverses the sale and is negative. Comparing either against the order's
  // face value would raise a warning on every cancelled order, which teaches
  // people to ignore the warning that matters.
  const orderTotal = round2(order.total);
  const expected = round2(orderTotal * signFor(first["Transaction Type"]));
  const reconciles = Math.abs(totals.grand - expected) <= 0.01;

  return {
    invoiceNumber: String(order.number),
    // The order date, for the same reason the MTR uses it: a COD order paid on
    // delivery would otherwise carry an invoice date in the following month.
    // The MTR keeps a full timestamp in this column; an invoice shows a date.
    invoiceDate: String(first["Invoice Date"]).slice(0, 10),
    orderNumber: String(order.number),
    transactionType: first["Transaction Type"],
    seller: SELLER,
    buyer: (() => {
      const billing = person(order.billing);
      const shipping = person(order.shipping?.address_1 ? order.shipping : order.billing);
      return {
        ...billing,
        // A WooCommerce shipping address often carries no name of its own, and
        // a "Ship to" block with a blank first line reads as missing data on a
        // document someone has to act on. The buyer's name is the right answer.
        shipping: { ...shipping, name: shipping.name || billing.name },
      };
    })(),
    placeOfSupply: shipTo,
    intraState,
    lines,
    charges,
    totals,
    amountInWords: amountInWords(totals.grand),
    payment: {
      method: order.paymentMethodTitle || order.paymentMethod || "",
      isCod: String(order.paymentMethod || "").toLowerCase().includes("cod"),
      isPaid: Boolean(order.datePaid),
    },
    orderTotal,
    reconciles,
    expectedTotal: expected,
    difference: round2(totals.grand - expected),
  };
}
