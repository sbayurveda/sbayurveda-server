// GST arithmetic for the tax report.
//
// Every amount this store collects is tax-inclusive: the price on the product
// page is what the customer pays, and GST is carved out of it rather than added
// on top. Amazon's own B2C Merchant Tax Report for this seller works the same
// way — across all 507 shipment rows of August 2026, Tax Exclusive Gross plus
// Total Tax equals Invoice Amount exactly, every time. That reconciliation is
// the property a filing document has to have, so it is the one enforced here:
// the components always add back to the rupee that was collected.
//
// Place of supply: this seller ships from Haryana under GSTIN 06ISBPK6890P1ZU.
// A sale inside Haryana is CGST + SGST at half the rate each; anywhere else in
// India is IGST at the full rate. That is the only thing the destination state
// changes.
//
// Nothing here decides a tax RATE. Rates come from the product's HSN code and
// are the accountant's call, not this file's.

export const ORIGIN_STATE = "HARYANA";
export const SELLER_GSTIN = process.env.SELLER_GSTIN || "06ISBPK6890P1ZU";

// Ayurvedic medicaments. 506 of the 507 shipment lines in the reference month
// carried this code at 5%.
export const DEFAULT_HSN = "3004";
export const DEFAULT_GST_RATE = Number(process.env.DEFAULT_GST_RATE || 5);

function round2(n) {
  // Number.EPSILON lifts values that binary floating point leaves a hair below
  // the halfway point (1.005 is stored as 1.00499...), which would otherwise
  // round down and lose a paisa.
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function normaliseState(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

// True when the buyer is in the same state we ship from, which is what decides
// CGST+SGST versus IGST.
export function isIntraState(shipToState) {
  return normaliseState(shipToState) === normaliseState(ORIGIN_STATE);
}

/**
 * Carves GST out of a tax-inclusive amount.
 *
 * Tax is computed first and the net is whatever remains, rather than the other
 * way round. Rounding the net and subtracting can leave the components a paisa
 * short of the collected amount; this order cannot, because the net absorbs the
 * rounding.
 *
 * Returns rupees, each rounded to paise, with cgst+sgst+igst === tax and
 * net+tax === gross.
 */
export function splitInclusiveGst({ gross, ratePct, shipToState }) {
  const amount = Number(gross) || 0;
  const rate = (Number(ratePct) || 0) / 100;

  if (!amount || rate <= 0) {
    return { gross: round2(amount), net: round2(amount), tax: 0, cgst: 0, sgst: 0, igst: 0, ratePct: Number(ratePct) || 0, intraState: isIntraState(shipToState) };
  }

  const tax = round2((amount * rate) / (1 + rate));
  const net = round2(amount - tax);
  const intraState = isIntraState(shipToState);

  // Halving can land on a half-paisa. Deriving the second component by
  // subtraction keeps the pair summing to the tax exactly.
  const cgst = intraState ? round2(tax / 2) : 0;
  const sgst = intraState ? round2(tax - cgst) : 0;
  const igst = intraState ? 0 : tax;

  return { gross: round2(amount), net, tax, cgst, sgst, igst, ratePct: Number(ratePct) || 0, intraState };
}

/**
 * The rate that applies to a delivery or cash-on-delivery charge.
 *
 * Under a composite supply the whole bundle is taxed at the rate of the
 * principal supply — the goods — so a ₹36 COD fee on an order of 5% medicines
 * carries 5%, not a service rate of its own. The principal supply is taken as
 * the highest-value line, which is unambiguous in the normal case where every
 * line on an order shares one rate.
 *
 * Returns 0 for an order with no priced lines, so a charge on an empty order is
 * never taxed at a guessed rate.
 */
export function principalRatePct(lines) {
  const priced = (lines || []).filter((l) => Number(l.gross) > 0 && Number(l.ratePct) > 0);
  if (!priced.length) return 0;
  return priced.reduce((best, l) => (Number(l.gross) > Number(best.gross) ? l : best)).ratePct;
}

/**
 * Breaks one order into the tax lines a return needs.
 *
 * `lines` are the goods: { description, hsn, sku, qty, gross, ratePct }, each
 * gross being tax-inclusive. `shippingGross` and `codFeeGross` are the charges,
 * both taxed at the principal supply's rate.
 *
 * The invoice total is asserted against the order's own total: a report whose
 * rows do not add up to what the customer paid is worse than no report, so a
 * mismatch is returned rather than hidden.
 */
export function taxBreakdownForOrder({ lines = [], shippingGross = 0, codFeeGross = 0, shipToState, orderTotal }) {
  const goods = lines.map((line) => ({
    ...line,
    ...splitInclusiveGst({ gross: line.gross, ratePct: line.ratePct, shipToState }),
  }));

  const rate = principalRatePct(lines);
  const shipping = splitInclusiveGst({ gross: shippingGross, ratePct: rate, shipToState });
  const codFee = splitInclusiveGst({ gross: codFeeGross, ratePct: rate, shipToState });

  const add = (pick) =>
    round2(goods.reduce((s, g) => s + pick(g), 0) + pick(shipping) + pick(codFee));

  const totals = {
    gross: add((x) => x.gross),
    net: add((x) => x.net),
    tax: add((x) => x.tax),
    cgst: add((x) => x.cgst),
    sgst: add((x) => x.sgst),
    igst: add((x) => x.igst),
  };

  const expected = orderTotal == null ? totals.gross : round2(Number(orderTotal));
  // A paisa of drift is rounding; anything larger means a charge we did not
  // account for, and the report must say so instead of quietly disagreeing
  // with the order.
  const reconciles = Math.abs(totals.gross - expected) <= 0.01;

  return {
    goods,
    shipping,
    codFee,
    totals,
    principalRatePct: rate,
    intraState: isIntraState(shipToState),
    reconciles,
    difference: round2(totals.gross - expected),
  };
}

/**
 * Splits a tax figure WooCommerce has already worked out.
 *
 * Where the shop recorded the tax itself, that figure is what the customer was
 * actually charged, so it is the one the return must carry — recomputing it
 * would only introduce a difference of opinion with the invoice. All this does
 * is divide it the way the destination requires.
 */
export function splitRecordedTax({ net, tax, shipToState }) {
  const n = round2(Number(net) || 0);
  const t = round2(Number(tax) || 0);
  const intraState = isIntraState(shipToState);
  const cgst = intraState ? round2(t / 2) : 0;
  const sgst = intraState ? round2(t - cgst) : 0;
  return {
    gross: round2(n + t),
    net: n,
    tax: t,
    cgst,
    sgst,
    igst: intraState ? 0 : t,
    // Reported back from the figures themselves, so the rate in the file is
    // the one actually applied rather than the one we would have chosen.
    ratePct: n > 0 ? Math.round((t / n) * 10000) / 100 : 0,
    intraState,
  };
}
