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

import { taxBreakdownForOrder, SELLER_GSTIN, DEFAULT_HSN, DEFAULT_GST_RATE, ORIGIN_STATE } from "./gst.js";

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

function codFeeOf(order) {
  return (order.feeLines || [])
    .filter((f) => /cash on delivery|cod/i.test(f.name || ""))
    .reduce((s, f) => s + Number(f.total || 0), 0);
}

/**
 * One order becomes one row per line item, the way the MTR is structured.
 *
 * Shipping and the COD fee are not rows of their own — they ride on the first
 * line, in the Shipping columns, which is how Amazon reports them.
 */
export function orderToMtrRows(order, { hsnByProductId = {}, rateOverrides = {} } = {}) {
  const shipTo = order.shipping?.state || order.billing?.state || "";
  const lines = (order.lineItems || []).map((li) => {
    const hsn = hsnByProductId[li.productId] || DEFAULT_HSN;
    return {
      productId: li.productId,
      description: li.name,
      sku: li.sku || "",
      qty: Number(li.qty || 0),
      gross: Number(li.total || 0),
      hsn,
      ratePct: rateForHsn(hsn, rateOverrides),
    };
  });

  const shippingGross = Number(order.shippingTotal || 0);
  const codFeeGross = codFeeOf(order);

  const b = taxBreakdownForOrder({
    lines,
    shippingGross,
    // The COD fee is reported in the shipping columns: it is a charge on the
    // same supply, and the MTR has no column of its own for it.
    codFeeGross,
    shipToState: shipTo,
    orderTotal: Number(order.total || 0),
  });

  const type = transactionTypeFor(order.status);
  const charges = {
    gross: b.shipping.gross + b.codFee.gross,
    cgst: b.shipping.cgst + b.codFee.cgst,
    sgst: b.shipping.sgst + b.codFee.sgst,
    igst: b.shipping.igst + b.codFee.igst,
  };

  return b.goods.map((g, i) => {
    // Charges sit on the first line only, so summing the file does not
    // multiply them by the number of items in the order.
    const first = i === 0;
    const sh = first ? charges : { gross: 0, cgst: 0, sgst: 0, igst: 0 };
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
      "Invoice Amount": g.gross + sh.gross,
      "Tax Exclusive Gross": g.net + (first ? b.shipping.net + b.codFee.net : 0),
      "Total Tax Amount": g.tax + sh.cgst + sh.sgst + sh.igst,
      "Cgst Rate": b.intraState ? g.ratePct / 200 : 0,
      "Sgst Rate": b.intraState ? g.ratePct / 200 : 0,
      "Utgst Rate": 0,
      "Igst Rate": b.intraState ? 0 : g.ratePct / 100,
      "Compensatory Cess Rate": 0,
      "Principal Amount": g.gross,
      "Principal Amount Basis": g.net,
      "Cgst Tax": g.cgst,
      "Sgst Tax": g.sgst,
      "Igst Tax": g.igst,
      "Utgst Tax": 0,
      "Compensatory Cess Tax": 0,
      "Shipping Amount": sh.gross,
      "Shipping Amount Basis": first ? b.shipping.net + b.codFee.net : 0,
      "Shipping Cgst Tax": sh.cgst,
      "Shipping Sgst Tax": sh.sgst,
      "Shipping Utgst Tax": 0,
      "Shipping Igst Tax": sh.igst,
      "Shipping Cess Tax Amount": 0,
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

  const rows = [];
  const unreconciled = [];
  for (const order of inRange) {
    const check = taxBreakdownForOrder({
      lines: (order.lineItems || []).map((li) => ({
        gross: Number(li.total || 0),
        ratePct: rateForHsn(hsnByProductId[li.productId] || DEFAULT_HSN, rateOverrides),
      })),
      shippingGross: Number(order.shippingTotal || 0),
      codFeeGross: codFeeOf(order),
      shipToState: order.shipping?.state || order.billing?.state || "",
      orderTotal: Number(order.total || 0),
    });
    if (!check.reconciles) {
      unreconciled.push({ order: order.number, difference: check.difference, total: Number(order.total || 0) });
    }
    rows.push(...orderToMtrRows(order, { hsnByProductId, rateOverrides }));
  }

  const sum = (col) => Math.round(rows.reduce((s, r) => s + (Number(r[col]) || 0), 0) * 100) / 100;
  const byType = (t) => rows.filter((r) => r["Transaction Type"] === t).length;

  return {
    rows,
    csv: rowsToCsv(rows),
    summary: {
      from,
      to,
      orders: inRange.length,
      lines: rows.length,
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
