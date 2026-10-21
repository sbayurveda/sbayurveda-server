// A real invoice series: SB00000001, SB00000002, ...
//
// Until now the invoice number was the WooCommerce order number, which is a
// WordPress post ID. Post IDs are handed out to everything — products, images,
// and a draft order for every abandoned checkout — so the series had 235
// breaks and 4,209 unused numbers across this year, and a quiet hour looked
// like a leap from 13782 to 13867. GST wants a consecutive serial number.
//
// The order number itself is untouched. It stays exactly as it is in the
// orders list, in search, on the customer's tracking page and in WooCommerce;
// only the number printed on the invoice changes.
//
// Two rules make this safe:
//
//   1. A number is assigned once and stored on the order itself, in
//      WooCommerce, not in a counter file on this server. A counter in
//      STORE_DIR would reset if the directory moved or the host restarted,
//      and a reset invoice counter issues duplicate invoice numbers.
//
//   2. Orders invoiced before the cutover keep the number they were already
//      invoiced under. Reprinting April's invoice must still say 7624,
//      because that is the document the customer has and the return carries.

export const PREFIX = process.env.INVOICE_PREFIX || "SB";
export const DIGITS = 8;

// Orders created on or after this date are numbered in the new series.
// Anything earlier was already invoiced under its order number.
export const SERIES_FROM = process.env.INVOICE_SERIES_FROM || "2026-10-21";

const PATTERN = new RegExp(`^${PREFIX}(\\d{${DIGITS}})$`);

export function formatInvoiceNo(n) {
  return `${PREFIX}${String(Math.max(1, Math.floor(Number(n) || 0))).padStart(DIGITS, "0")}`;
}

/** The sequence number inside a formatted invoice number, or null. */
export function parseInvoiceNo(value) {
  const m = PATTERN.exec(String(value || "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * True when an order belongs in the new series.
 *
 * Compared on the date alone, so an order placed at any time on the cutover
 * day counts.
 */
export function inNewSeries(order, from = SERIES_FROM) {
  const created = String(order?.dateCreated || "").slice(0, 10);
  return Boolean(created) && created >= from;
}

/**
 * The next number to issue, from the numbers already issued.
 *
 * Derived from the orders themselves rather than a stored counter, so there
 * is one source of truth and nothing to get out of step. Gaps are impossible
 * because a number is only ever taken by being written to an order.
 */
export function nextInvoiceSeq(orders = []) {
  let highest = 0;
  for (const o of orders) {
    const n = parseInvoiceNo(o?.invoiceNo);
    if (n && n > highest) highest = n;
  }
  return highest + 1;
}

/**
 * What to print on an order's invoice.
 *
 * An assigned number always wins, so a reprint never changes. Otherwise an
 * older order shows the order number it was originally invoiced under, and a
 * new one shows nothing until it is issued.
 */
export function invoiceNoFor(order) {
  if (order?.invoiceNo) return order.invoiceNo;
  return inNewSeries(order) ? "" : String(order?.number ?? "");
}
