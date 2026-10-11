// The monthly tax report, in the shape of Amazon's B2C Merchant Tax Report.
//
// The column list and ordering are taken from this seller's own August 2026
// MTR so the file drops into whatever the accountant already works with. Only
// the columns a direct-to-customer web shop can actually fill are populated;
// the rest are present and empty rather than dropped, because a return built
// on a file with missing columns is a conversation nobody wants to have.
//
// Amazon-specific columns stay blank on purpose: no ASIN, no warehouse, no TCS
// (that is collected by a marketplace operator, which we are not), no gift
// wrap. Invoice numbers are the WooCommerce order number.

import {
  taxBreakdownForOrder, splitRecordedTax, splitInclusiveGst, isIntraState,
  SELLER_GSTIN, DEFAULT_HSN, DEFAULT_GST_RATE, ORIGIN_STATE,
} from "./gst.js";

export const MTR_COLUMNS = [
  "Seller Gstin", "Invoice Number", "Invoice Date", "Transaction Type", "Order Id",
  "Shipment Id", "Shipment Date", "Order Date", "Shipment Item Id", "Quantity",
  "Item Description", "Asin", "Hsn/sac", "Sku", "Product Tax Code",
  "Bill From City", "Bill From State", "Bill From Country", "Bill From Postal Code",
  "Ship From City", "Ship From State", "Ship From Country", "Ship From Postal Code",
  "Ship To City", "Ship To State", "Ship To Country", "Ship To Postal Code",
  "Invoice Amount", "Tax Exclusive Gross", "Total Tax Amount",
  "Cgst Rate", "Sgst Rate", "Utgst Rate", "Igst Rate", "Compensatory Cess Rate",
  "Principal Amount", "Principal Amount Basis",
  "Cgst Tax", "Sgst Tax", "Igst Tax", "Utgst Tax", "Compensatory Cess Tax",
  "Shipping Amount", "Shipping Amount Basis",
  "Shipping Cgst Tax", "Shipping Sgst Tax", "Shipping Utgst Tax", "Shipping Igst Tax",
  "Shipping Cess Tax Amount",
  "Gift Wrap Amount", "Gift Wrap Amount Basis",
  "Gift Wrap Cgst Tax", "Gift Wrap Sgst Tax", "Gift Wrap Utgst Tax", "Gift Wrap Igst Tax",
  "Gift Wrap Compensatory Cess Tax",
  "Item Promo Discount", "Item Promo Discount Basis", "Item Promo Tax",
  "Shipping Promo Discount", "Shipping Promo Discount Basis", "Shipping Promo Tax",
  "Gift Wrap Promo Discount", "Gift Wrap Promo Discount Basis", "Gift Wrap Promo Tax",
  "Tcs Cgst Rate", "Tcs Cgst Amount", "Tcs Sgst Rate", "Tcs Sgst Amount",
  "Tcs Utgst Rate", "Tcs Utgst Amount", "Tcs Igst Rate", "Tcs Igst Amount",
  "Warehouse Id", "Fulfillment Channel", "Payment Method Code",
  "Credit Note No", "Credit Note Date",
];

const SHIP_FROM = {
  city: process.env.SHIP_FROM_CITY || "Shahbad",
  state: process.env.SHIP_FROM_STATE || ORIGIN_STATE,
  postcode: process.env.SHIP_FROM_PIN || "136156",
};

// WooCommerce statuses, in the three buckets a return cares about. A
// cancellation and a refund are not the same event: one never shipped, the
// other reverses an invoice that did.
const CANCELLED = ["cancelled", "failed"];
const REFUNDED = ["refunded"];

export function transactionTypeFor(status) {
  if (CANCELLED.includes(status)) return "Cancel";
  if (REFUNDED.includes(status)) return "Refund";
  return "Shipment";
}

function isoDate(value) {
  return String(value || "").replace("T", " ").slice(0, 19);
}

// A product's GST rate comes from its HSN code. Ayurvedic medicaments (3004)
// are 5%, which covers all but one line of the reference month. Anything whose
// code we do not hold falls back to the default rather than to zero: a missing
// rate that silently under-reports tax is the worst failure this file has.
export function rateForHsn(hsn, overrides = {}) {
  const code = String(hsn || "").trim();
  if (overrides[code] != null) return Number(overrides[code]);
  if (code === "3004") return 5;
  return DEFAULT_GST_RATE;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const IS_COD_FEE = (name) => /cash on delivery|cod/i.test(String(name || ""));

/**
 * One charge, taxed the way it actually was.
 *
 * WooCommerce reports a line's `total` net of tax and its `total_tax`
 * separately. Reading `total` as the gross — which this file did — understated
 * every order by exactly the tax the shop had already worked out, and then
 * carved a second 5% out of the remainder. Thirty-five orders in one month came
 * back "off by" precisely their recorded tax: ₹13.33 on a ₹280 sale, ₹40.00 on
 * ₹840.
 *
 * Where the shop recorded the tax, that figure wins: it is what the customer
 * was charged. Where it recorded none — older orders, before GST was set up —
 * the tax is carved out of the amount at the product's HSN rate instead, so
 * those orders are still reported rather than shown as tax-free.
 */
function taxedPart({ net, recordedTax, ratePct, shipToState }) {
  const t = Number(recordedTax) || 0;
  if (t > 0) return splitRecordedTax({ net, tax: t, shipToState });
  return splitInclusiveGst({ gross: Number(net) || 0, ratePct, shipToState });
}

/**
 * Everything on an order that is not a product line.
 *
 * This store has no WooCommerce coupon objects: a discount is written as a
 * negative fee line. Counting only the COD fee, as this file first did, left
 * every discounted order short by the value of its discount — which is what
 * the reconciliation check caught.
 */
function chargesOf(order) {
  const fees = order.feeLines || [];
  const positive = (f) => Number(f.total || 0) > 0;
  const sum = (list, pick) => list.reduce((s, f) => s + (Number(pick(f)) || 0), 0);
  const cod = fees.filter((f) => positive(f) && IS_COD_FEE(f.name));
  const other = fees.filter((f) => positive(f) && !IS_COD_FEE(f.name));
  return {
    codNet: sum(cod, (f) => f.total),
    codTax: sum(cod, (f) => f.totalTax),
    otherNet: sum(other, (f) => f.total),
    otherTax: sum(other, (f) => f.totalTax),
    shippingNet: Number(order.shippingTotal || 0),
    shippingTax: Number(order.shippingTax || 0),
    // mapAdminOrder has already folded negative fee lines in with any real
    // coupon total, so this is the whole discount and must not be re-derived.
    discount: Number(order.discountTotal || 0),
  };
}

/**
 * Spreads a discount across the lines it applies to, pro rata by value.
 *
 * GST is due on the consideration actually received, so a discount has to come
 * off the taxable value rather than sit beside it. The final line absorbs the
 * rounding, so the shares always add back to the discount exactly.
 */
export function apportionDiscount(lines, discount) {
  const total = lines.reduce((s, l) => s + Number(l.gross || 0), 0);
  if (!discount || total <= 0) return lines.map((l) => ({ ...l, discount: 0 }));

  let left = round2(discount);
  return lines.map((l, i) => {
    const share = i === lines.length - 1 ? round2(left) : round2((discount * Number(l.gross)) / total);
    left = round2(left - share);
    return { ...l, gross: round2(Number(l.gross) - share), discount: share };
  });
}

/**
 * One order becomes one row per line item, the way the MTR is structured.
 *
 * Shipping and the COD fee are not rows of their own — they ride on the first
 * line, in the Shipping columns, which is how Amazon reports them.
 */
export function orderToMtrRows(order, { hsnByProductId = {}, rateOverrides = {} } = {}) {
  const shipTo = order.shipping?.state || order.billing?.state || "";
  const intra = isIntraState(shipTo);
  const c = chargesOf(order);

  // Discounts come off the net, since that is the figure the recorded tax was
  // computed against.
  const rawLines = (order.lineItems || []).map((li) => {
    const hsn = hsnByProductId[li.productId] || DEFAULT_HSN;
    return {
      productId: li.productId,
      description: li.name,
      sku: li.sku || "",
      qty: Number(li.qty || 0),
      gross: Number(li.total || 0),          // WooCommerce's net; named gross for apportioning
      recordedTax: Number(li.totalTax || 0),
      hsn,
      ratePct: rateForHsn(hsn, rateOverrides),
    };
  });
  const lines = apportionDiscount(rawLines, c.discount);

  const goods = lines.map((l) => ({
    ...l,
    ...taxedPart({ net: l.gross, recordedTax: l.recordedTax, ratePct: l.ratePct, shipToState: shipTo }),
  }));

  // Shipping and the COD fee ride in the shipping columns: both are charges on
  // the same supply and the MTR has no column of their own.
  const chargeNet = c.shippingNet + c.codNet + c.otherNet;
  const chargeTax = c.shippingTax + c.codTax + c.otherTax;
  const charge = taxedPart({
    net: chargeNet,
    recordedTax: chargeTax,
    // With no recorded tax, a charge follows the principal supply's rate.
    ratePct: goods.length ? goods[0].ratePct : DEFAULT_GST_RATE,
    shipToState: shipTo,
  });

  const type = transactionTypeFor(order.status);

  return goods.map((g, i) => {
    const first = i === 0;
    const sh = first ? charge : { gross: 0, net: 0, tax: 0, cgst: 0, sgst: 0, igst: 0 };
    const row = {
      "Seller Gstin": SELLER_GSTIN,
      "Invoice Number": order.number,
      "Invoice Date": isoDate(order.datePaid || order.dateCreated),
      "Transaction Type": type,
      "Order Id": order.number,
      "Shipment Id": order.trackingCode || "",
      "Shipment Date": isoDate(order.dateCompleted || order.dateCreated),
      "Order Date": isoDate(order.dateCreated),
      "Shipment Item Id": `${order.id}-${g.productId || i + 1}`,
      Quantity: g.qty,
      "Item Description": g.description,
      Asin: "",
      "Hsn/sac": g.hsn,
      Sku: g.sku,
      "Product Tax Code": "",
      "Bill From City": SHIP_FROM.city,
      "Bill From State": SHIP_FROM.state,
      "Bill From Country": "IN",
      "Bill From Postal Code": SHIP_FROM.postcode,
      "Ship From City": SHIP_FROM.city,
      "Ship From State": SHIP_FROM.state,
      "Ship From Country": "IN",
      "Ship From Postal Code": SHIP_FROM.postcode,
      "Ship To City": order.shipping?.city || order.billing?.city || "",
      "Ship To State": shipTo,
      "Ship To Country": "IN",
      "Ship To Postal Code": order.shipping?.postcode || order.billing?.postcode || "",
      "Invoice Amount": round2(g.gross + sh.gross),
      "Tax Exclusive Gross": round2(g.net + sh.net),
      "Total Tax Amount": round2(g.tax + sh.tax),
      "Cgst Rate": intra ? g.ratePct / 200 : 0,
      "Sgst Rate": intra ? g.ratePct / 200 : 0,
      "Utgst Rate": 0,
      "Igst Rate": intra ? 0 : g.ratePct / 100,
      "Compensatory Cess Rate": 0,
      "Principal Amount": g.gross,
      "Principal Amount Basis": g.net,
      "Cgst Tax": g.cgst,
      "Sgst Tax": g.sgst,
      "Igst Tax": g.igst,
      "Utgst Tax": 0,
      "Compensatory Cess Tax": 0,
      "Shipping Amount": sh.gross,
      "Shipping Amount Basis": sh.net,
      "Shipping Cgst Tax": sh.cgst,
      "Shipping Sgst Tax": sh.sgst,
      "Shipping Utgst Tax": 0,
      "Shipping Igst Tax": sh.igst,
      "Shipping Cess Tax Amount": 0,
      // The discount came off the taxable value above; this records how much.
      "Item Promo Discount": g.discount || 0,
      "Item Promo Discount Basis": g.discount || 0,
      "Item Promo Tax": 0,
      "Warehouse Id": "",
      "Fulfillment Channel": "MFN",
      "Payment Method Code": String(order.paymentMethod || "").toUpperCase() === "COD" ? "COD" : "Prepaid",
      "Credit Note No": type === "Refund" ? order.number : "",
      "Credit Note Date": type === "Refund" ? isoDate(order.dateModified) : "",
    };
    for (const col of MTR_COLUMNS) if (!(col in row)) row[col] = "";
    return row;
  });
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows) {
  const head = MTR_COLUMNS.map(csvCell).join(",");
  const body = rows.map((r) => MTR_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return [head, ...body].join("\n");
}

/**
 * Builds the report for one month, plus the totals an accountant checks first
 * and the list of orders whose lines did not add up to what was collected.
 */
export function buildMtr(orders, { from, to, hsnByProductId = {}, rateOverrides = {} } = {}) {
  const inRange = orders.filter((o) => {
    const day = String(o.dateCreated || "").slice(0, 10);
    return day >= from && day <= to;
  });

  const out = [];
  const unreconciled = [];
  for (const order of inRange) {
    const rows = orderToMtrRows(order, { hsnByProductId, rateOverrides });
    const invoiced = round2(rows.reduce((t, r) => t + Number(r["Invoice Amount"] || 0), 0));
    const check = {
      reconciles: Math.abs(invoiced - round2(Number(order.total || 0))) <= 0.02,
      difference: round2(invoiced - round2(Number(order.total || 0))),
    };
    if (!check.reconciles) {
      unreconciled.push({ order: order.number, difference: check.difference, total: Number(order.total || 0) });
    }
    out.push(...rows);
  }

  const sum = (col) => round2(out.reduce((s, r) => s + (Number(r[col]) || 0), 0));
  const byType = (t) => out.filter((r) => r["Transaction Type"] === t).length;

  return {
    rows: out,
    csv: rowsToCsv(out),
    summary: {
      from,
      to,
      orders: inRange.length,
      lines: out.length,
      shipments: byType("Shipment"),
      cancellations: byType("Cancel"),
      refunds: byType("Refund"),
      invoiceTotal: sum("Invoice Amount"),
      taxableValue: sum("Tax Exclusive Gross"),
      totalTax: sum("Total Tax Amount"),
      cgst: sum("Cgst Tax") + sum("Shipping Cgst Tax"),
      sgst: sum("Sgst Tax") + sum("Shipping Sgst Tax"),
      igst: sum("Igst Tax") + sum("Shipping Igst Tax"),
    },
    unreconciled,
  };
}
