// A tax invoice for one order.
//
// Built from orderToMtrRows — the very rows that go into the GST return —
// rather than from a second reading of the order. An invoice that disagrees
// with the filing is worse than no invoice: it is the document a claim is
// assessed against, and the two have to say the same thing to the paisa. So
// the numbers here are not recomputed, only regrouped.

import { orderToMtrRows, SHIP_FROM, rateForHsn, signFor } from "./mtr.js";
import { SELLER_GSTIN, isIntraState } from "./gst.js";
import { invoiceNoFor } from "./invoiceNumber.js";

// Taken from the invoice this shop already issues, so the document the
// dashboard produces is the same one their customers and their accountant
// already recognise.
export const SELLER = {
  name: process.env.SELLER_NAME || "SB Ayurveda",
  gstin: SELLER_GSTIN,
  addressLines: (process.env.SELLER_ADDRESS
    || "Ground Floor, Barara Road, Babain|Kurukshetra 136156|Haryana, India")
    .split("|")
    .map((l) => l.trim())
    .filter(Boolean),
  state: SHIP_FROM.state,
  email: process.env.SELLER_EMAIL || "sbayurveda4@gmail.com",
  phone: process.env.SELLER_PHONE || "",
};

// The existing invoice prints the state as its two-letter code.
const STATE_CODES = {
  "ANDHRA PRADESH": "AP", "ARUNACHAL PRADESH": "AR", ASSAM: "AS", BIHAR: "BR",
  CHHATTISGARH: "CG", GOA: "GA", GUJARAT: "GJ", HARYANA: "HR",
  "HIMACHAL PRADESH": "HP", JHARKHAND: "JH", KARNATAKA: "KA", KERALA: "KL",
  "MADHYA PRADESH": "MP", MAHARASHTRA: "MH", MANIPUR: "MN", MEGHALAYA: "ML",
  MIZORAM: "MZ", NAGALAND: "NL", ODISHA: "OD", PUNJAB: "PB", RAJASTHAN: "RJ",
  SIKKIM: "SK", "TAMIL NADU": "TN", TELANGANA: "TS", TRIPURA: "TR",
  "UTTAR PRADESH": "UP", UTTARAKHAND: "UK", "WEST BENGAL": "WB",
  DELHI: "DL", "JAMMU AND KASHMIR": "JK", LADAKH: "LA", PUDUCHERRY: "PY",
  CHANDIGARH: "CH", "ANDAMAN AND NICOBAR ISLANDS": "AN",
  "DADRA AND NAGAR HAVELI AND DAMAN AND DIU": "DN", LAKSHADWEEP: "LD",
};

export function stateCode(name) {
  const key = String(name || "").trim().toUpperCase();
  // A two-letter value is already a code, which is how WooCommerce often
  // stores it.
  if (/^[A-Z]{2}$/.test(key)) return key;
  return STATE_CODES[key] || String(name || "");
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// "June 15, 2026" — the format the existing invoice uses.
export function longDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso || "");
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

function round2(n) {
  return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function underThousand(n) {
  if (n < 20) return ONES[n];
  // Hyphenated, as the existing invoice writes it: "Ninety-six", not
  // "Ninety Six".
  if (n < 100) return (TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10].toLowerCase() : "")).trim();
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
export function buildInvoice(order, { hsnByProductId = {}, rateOverrides = {}, mrpByProductId = {} } = {}) {
  const rows = orderToMtrRows(order, { hsnByProductId, rateOverrides });
  if (!rows.length) {
    throw Object.assign(new Error("That order has no items to invoice."), { status: 400 });
  }

  const shipTo = order.shipping?.state || order.billing?.state || "";
  const intraState = isIntraState(shipTo);

  const lineItemsById = new Map((order.lineItems || []).map((li) => [String(li.productId), li]));

  const lines = rows.map((r) => {
    const qty = Number(r.Quantity) || 0;
    const amount = round2(r["Principal Amount"]);
    const li = lineItemsById.get(String(r["Shipment Item Id"]).split("-")[1] || "");
    // MRP is the catalogue list price, not what was charged — it is what the
    // discount column is measured against. The product's own regular price is
    // the right source; the line's pre-coupon subtotal is the fallback for a
    // product that has since been edited or deleted.
    const unitMrp = Number(mrpByProductId[li?.productId]) || 0;
    const mrp = round2(unitMrp ? unitMrp * qty : (li?.subtotal ?? amount));
    // The existing invoice measures the discount against the amount actually
    // charged, inclusive of tax — (1199 - 1060) / 1199 = 11.59%.
    const discPct = mrp > 0 && mrp > amount ? round2(((mrp - amount) / mrp) * 100) : 0;
    return {
      description: r["Item Description"],
      hsn: r["Hsn/sac"],
      sku: r.Sku,
      qty,
      mrp,
      discPct,
      taxable: round2(r["Principal Amount Basis"]),
      ratePct: rateForHsn(r["Hsn/sac"], rateOverrides),
      cgst: round2(r["Cgst Tax"]),
      sgst: round2(r["Sgst Tax"]),
      igst: round2(r["Igst Tax"]),
      total: amount,
    };
  });

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

  // The totals follow the invoice this shop already issues, where the
  // cash-on-delivery charge is a flat line beneath the tax rather than part of
  // the taxable value: Taxable Amount, tax, the charge, Total Payable.
  //
  // Worth being explicit, because it differs from the GST return. The return
  // treats the 36 rupee fee as tax-inclusive — 34.29 plus 1.71 — exactly as
  // asked. The invoice shows the fee whole and the taxable value as goods
  // only, so the two documents describe the same money differently. Both add
  // up to what the customer paid, which is the property that matters here.
  const goods = (pick) => round2(lines.reduce((s, l) => s + pick(l), 0));
  const totals = {
    taxable: goods((l) => l.taxable),
    cgst: goods((l) => l.cgst),
    sgst: goods((l) => l.sgst),
    igst: goods((l) => l.igst),
    quantity: lines.reduce((s, l) => s + l.qty, 0),
  };
  totals.tax = round2(totals.cgst + totals.sgst + totals.igst);
  // The charge, whole, the way the existing document prints it.
  totals.charge = charges ? round2(charges.total) : 0;
  totals.grand = round2(totals.taxable + totals.tax + totals.charge);

  // What the return will carry for the same order, so the difference is
  // visible rather than something an accountant has to discover.
  totals.filedTaxable = round2(totals.taxable + (charges ? charges.taxable : 0));
  totals.filedTax = round2(
    totals.tax + (charges ? round2(charges.cgst + charges.sgst + charges.igst) : 0),
  );

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
    // The issued invoice number, which is no longer the order number. An
    // order awaiting its first issue has none yet, and the dashboard says so
    // rather than printing a number that was never allocated.
    invoiceNumber: invoiceNoFor(order),
    // The order number is unchanged and still printed, so an invoice can
    // always be traced back to the order it belongs to.
    orderNumber: String(order.number),
    // The order date, for the same reason the MTR uses it: a COD order paid on
    // delivery would otherwise carry an invoice date in the following month.
    // The MTR keeps a full timestamp in this column; an invoice shows a date.
    invoiceDate: String(first["Invoice Date"]).slice(0, 10),
    transactionType: first["Transaction Type"],
    seller: SELLER,
    invoiceDateLong: longDate(String(first["Invoice Date"]).slice(0, 10)),
    orderDateLong: longDate(String(first["Order Date"]).slice(0, 10)),
    buyer: (() => {
      const billing = person(order.billing);
      const shipping = person(order.shipping?.address_1 ? order.shipping : order.billing);
      return {
        ...billing,
        // The existing invoice prints the state as its two-letter code.
        stateCode: stateCode(billing.state),
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
    // The label beside the charge on the totals block is the payment method,
    // which is what the existing invoice prints there.
    chargeLabel: order.paymentMethodTitle || order.paymentMethod || "Delivery charge",
    totals,
    // One HSN code for the whole invoice, shown in the header block rather
    // than per line — again following the existing document.
    hsnCode: lines[0]?.hsn || "",
    orderDate: String(first["Order Date"]).slice(0, 10),
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
