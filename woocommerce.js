// Server-side WooCommerce REST API v3 client — uses the authenticated
// Consumer Key/Secret (never exposed to the browser) to read live product
// prices and create real orders. This is the trusted source of truth for
// money: we never take a price from the client, only from here.

const WC_BASE_URL = process.env.WC_BASE_URL || "https://sbayurveda.com";
const CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;

function authHeader() {
  const token = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
  return `Basic ${token}`;
}

async function wcFetchRaw(path, options = {}) {
  const res = await fetch(`${WC_BASE_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WooCommerce API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

async function wcFetch(path, options = {}) {
  const res = await wcFetchRaw(path, options);
  return res.json();
}

// Numeric WooCommerce product IDs are embedded in our frontend's product.id
// as "wc-<id>" (see sb-ayurveda/src/utils/mapProduct.js).
function toWcId(frontendId) {
  const n = Number(String(frontendId).replace(/^wc-/, ""));
  if (!Number.isFinite(n)) throw new Error(`Invalid product id: ${frontendId}`);
  return n;
}

// Reads from the Store API. Bounded and retried once, because a single slow
// WordPress response used to leave the customer staring at "Placing Order..."
// for as long as the request took to give up.
//
// Retrying is only safe because these are GETs. Order creation is never
// retried — a timed-out POST may well have created the order, and a retry
// would bill the customer twice.
const STORE_TIMEOUT_MS = 8000;

async function storeFetchJson(path) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(`${WC_BASE_URL}/wp-json/wc/store/v1${path}`, {
        signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Store API responded ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Fetches current, authoritative prices for a set of cart items directly
// from WooCommerce (via its public Store API, no auth needed for reads) and
// computes the trusted order totals server-side.
//
// One request for the whole cart, not one per line. The previous version
// awaited a separate round trip per item, so checkout got slower the more a
// customer bought: measured against the live store a four-item cart took a
// median 5.5s here (worst 10.8s) versus 0.85s for the single batched call.
// Every price and stock check below is unchanged — this is the same live data,
// fetched once.
export async function priceCartItems(items) {
  const wanted = items.map((item) => ({
    wcId: toWcId(item.id),
    qty: Math.max(1, Math.floor(Number(item.qty) || 1)),
  }));

  const ids = [...new Set(wanted.map((i) => i.wcId))];
  const products = await storeFetchJson(
    `/products?include=${ids.join(",")}&per_page=${ids.length}`
  );
  const byId = new Map(products.map((p) => [String(p.id), p]));

  const priced = [];
  for (const { wcId, qty } of wanted) {
    const product = byId.get(String(wcId));
    // A requested id the collection didn't return is deleted or unpublished.
    if (!product) throw new Error(`Product ${wcId} not found or unavailable`);
    if (!product.is_purchasable) throw new Error(`Product ${wcId} is no longer purchasable`);
    // is_purchasable stays true even when a product is out of stock — it only
    // reflects that the product exists/is published, not stock status. This
    // check is what actually stops a customer from being charged for
    // something we can't fulfill.
    if (!product.is_in_stock) throw new Error(`${product.name} is currently out of stock`);
    priced.push({
      wcId,
      name: product.name,
      price: Number(product.prices.price) / 100,
      mrp: Number(product.prices.regular_price) / 100,
      qty,
    });
  }

  const subtotal = priced.reduce((sum, i) => sum + i.price * i.qty, 0);
  const mrpTotal = priced.reduce((sum, i) => sum + i.mrp * i.qty, 0);
  return { items: priced, subtotal, mrpTotal, savings: mrpTotal - subtotal };
}

function splitName(fullName) {
  const parts = (fullName || "").trim().split(/\s+/);
  return { first_name: parts[0] || "", last_name: parts.slice(1).join(" ") || "" };
}

// WooCommerce's Source column reads these meta keys, which its own checkout
// fills in from a tracking script. Orders created through this API never run
// that script, so the column stayed blank on every order — we pass through
// what the storefront captured on the customer's first page view instead.
function attributionMeta(attribution) {
  if (!attribution || typeof attribution !== "object") return [];
  const fields = {
    source_type: attribution.sourceType,
    utm_source: attribution.utmSource,
    utm_medium: attribution.utmMedium,
    utm_campaign: attribution.utmCampaign,
    utm_content: attribution.utmContent,
    utm_term: attribution.utmTerm,
    referrer: attribution.referrer,
    session_entry: attribution.sessionEntry,
    session_start_time: attribution.sessionStartTime,
    session_pages: attribution.sessionPages,
    session_count: attribution.sessionCount,
    device_type: attribution.deviceType,
    user_agent: attribution.userAgent,
  };
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ({
      key: `_wc_order_attribution_${key}`,
      value: String(value).slice(0, 500),
    }));
}

export async function createWooOrder({ pricedItems, customer, paymentMethod, paymentTitle, setPaid, status, shippingFee, codFee, coupon, metaData, transactionId, attribution }) {
  const { first_name, last_name } = splitName(customer.name);
  const address = {
    first_name,
    last_name,
    address_1: customer.flatBuilding,
    address_2: [customer.area, customer.landmark].filter(Boolean).join(", "),
    city: customer.city,
    state: customer.state,
    postcode: customer.pincode,
    country: "IN",
    email: customer.email,
    phone: customer.phone,
  };

  const order = await wcFetch("/orders", {
    method: "POST",
    body: JSON.stringify({
      payment_method: paymentMethod,
      payment_method_title: paymentTitle,
      set_paid: setPaid,
      status: status || undefined,
      // WooCommerce's own transaction_id field — without this the payment
      // reference only lived in custom meta, leaving the Transaction ID column
      // blank in both this dashboard and wp-admin, and making a payment
      // impossible to reconcile against Razorpay from the order screen.
      transaction_id: transactionId || undefined,
      billing: address,
      shipping: address,
      line_items: pricedItems.items.map((i) => ({ product_id: i.wcId, quantity: i.qty })),
      shipping_lines: shippingFee
        ? [{ method_id: "flat_rate", method_title: "Delivery Charges", total: String(shippingFee) }]
        : [],
      fee_lines: [
        // The COD fee is a payment-handling charge, not goods, so it is not
        // taxed — tax_status "none" keeps GST off it.
        ...(codFee ? [{ name: "Cash on Delivery Fee", total: String(codFee), tax_status: "none" }] : []),
        // A discount stays taxable so it reduces the taxable base — marking it
        // "none" would leave GST calculated on the pre-discount amount.
        ...(coupon?.valid && coupon.discount > 0
          ? [{ name: `Discount (${coupon.code})`, total: String(-coupon.discount) }]
          : []),
      ],
      meta_data: [...(metaData || []), ...attributionMeta(attribution)],
    }),
  });

  return { id: order.id, number: order.number, total: order.total };
}

// Reads back the real, current status of an order — used so the storefront's
// "My Orders" list reflects whatever's actually true in WooCommerce (order
// marked Completed/Cancelled/Refunded from wp-admin, etc.) instead of
// whatever status it happened to have at checkout time.
// Reads a tracking link out of order meta. Supports three formats: a plain
// URL pasted into a Custom Field yourself, the array format the "WooCommerce
// Shipment Tracking" plugin writes, and the "YITH WooCommerce Order Tracking"
// plugin's own meta key (the one actually in use on this store).
function extractTrackingUrl(metaData) {
  const meta = metaData || [];

  const plain = meta.find((m) => ["_tracking_url", "tracking_url"].includes(m.key));
  if (typeof plain?.value === "string" && plain.value.startsWith("http")) return plain.value;

  const yith = meta.find((m) => m.key === "ywot_carrier_url");
  if (typeof yith?.value === "string" && yith.value.startsWith("http")) return yith.value;

  const pluginMeta = meta.find((m) => m.key === "_wc_shipment_tracking_items");
  const items = Array.isArray(pluginMeta?.value) ? pluginMeta.value : null;
  const link = items?.[0]?.tracking_link || items?.[0]?.custom_tracking_link;
  if (typeof link === "string" && link.startsWith("http")) return link;

  return null;
}

export async function getWooOrder(orderId) {
  const order = await wcFetch(`/orders/${orderId}`);
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    total: order.total,
    dateCreated: order.date_created,
    dateModified: order.date_modified,
    paymentMethodTitle: order.payment_method_title,
    items: (order.line_items || []).map((li) => ({
      name: li.name,
      qty: li.quantity,
      total: li.total,
    })),
    billing: order.billing,
    totalTax: order.total_tax,
    shippingTotal: order.shipping_total,
    feeTotal: (order.fee_lines || []).reduce((sum, f) => sum + Number(f.total || 0), 0),
    // Only populated from real order meta — we never fabricate a tracking link.
    trackingUrl: extractTrackingUrl(order.meta_data),
  };
}

// ---------------------------------------------------------------------------
// Admin order history
//
// The customer-facing getWooOrder above deliberately returns a thin slice of an
// order. The admin dashboard needs the whole record (both addresses, per-line
// pricing, the tax split, payment/transaction refs, courier meta), so it gets
// its own fuller mapper rather than widening the customer one — a bug there
// would leak fields to whoever knows an order id + phone number.
// ---------------------------------------------------------------------------

function metaValue(metaData, key) {
  const entry = (metaData || []).find((m) => m.key === key);
  return entry?.value ?? null;
}

// Indian GST arrives as separate tax lines whose label/rate code names the
// component (CGST/SGST for intra-state, IGST for inter-state). Matching on the
// label keeps this working whatever rate percentages are configured.
function sumTaxByLabel(taxLines, needle) {
  return (taxLines || [])
    .filter((t) => `${t.label || ""} ${t.rate_code || ""}`.toUpperCase().includes(needle))
    .reduce((sum, t) => sum + Number(t.tax_total || 0) + Number(t.shipping_tax_total || 0), 0);
}

export function mapAdminOrder(order) {
  const lineItems = (order.line_items || []).map((li) => ({
    id: li.id,
    productId: li.product_id,
    name: li.name,
    sku: li.sku || "",
    qty: Number(li.quantity || 0),
    price: Number(li.price || 0),
    subtotal: Number(li.subtotal || 0),
    total: Number(li.total || 0),
    totalTax: Number(li.total_tax || 0),
  }));

  const feeLines = (order.fee_lines || []).map((f) => ({
    name: f.name,
    total: Number(f.total || 0),
    totalTax: Number(f.total_tax || 0),
  }));

  // Coupon discounts on this store are written as negative fee lines (there are
  // no real WC coupon objects), so a discount can show up in either place.
  const negativeFees = feeLines
    .filter((f) => f.total < 0)
    .reduce((sum, f) => sum + Math.abs(f.total), 0);
  const positiveFees = feeLines
    .filter((f) => f.total > 0)
    .reduce((sum, f) => sum + f.total, 0);

  const itemsSubtotal = lineItems.reduce((sum, i) => sum + i.subtotal, 0);
  const itemsTotal = lineItems.reduce((sum, i) => sum + i.total, 0);

  return {
    id: order.id,
    number: order.number,
    status: order.status,
    currency: order.currency || "INR",
    dateCreated: order.date_created,
    dateModified: order.date_modified,
    datePaid: order.date_paid,
    dateCompleted: order.date_completed,

    billing: order.billing || {},
    shipping: order.shipping || {},
    customerNote: order.customer_note || "",

    lineItems,
    feeLines,
    itemsSubtotal,
    itemsTotal,
    extraFees: positiveFees,
    discountTotal: Number(order.discount_total || 0) + negativeFees,
    couponLines: (order.coupon_lines || []).map((c) => ({
      code: c.code,
      discount: Number(c.discount || 0),
    })),
    shippingTotal: Number(order.shipping_total || 0),
    shippingTax: Number(order.shipping_tax || 0),
    totalTax: Number(order.total_tax || 0),
    cgst: sumTaxByLabel(order.tax_lines, "CGST"),
    sgst: sumTaxByLabel(order.tax_lines, "SGST"),
    igst: sumTaxByLabel(order.tax_lines, "IGST"),
    total: Number(order.total || 0),

    paymentMethod: order.payment_method || "",
    paymentMethodTitle: order.payment_method_title || "",
    transactionId: order.transaction_id || "",
    // WooCommerce only stamps date_paid once payment actually settles, so this
    // is the honest "has the money arrived" signal — not the order status.
    isPaid: Boolean(order.date_paid),

    // Written by WooCommerce's own attribution for checkout orders, and by us
    // for API-created ones. Absent on anything placed before we started
    // recording it, which the dashboard reports as "not recorded".
    sourceType: metaValue(order.meta_data, "_wc_order_attribution_source_type") || "",
    utmSource: metaValue(order.meta_data, "_wc_order_attribution_utm_source") || "",

    // Used to reconcile against Razorpay: a captured payment whose id appears on
    // no order is money taken with nothing shipped.
    razorpayPaymentId: metaValue(order.meta_data, "razorpay_payment_id") || order.transaction_id || "",
    // Set when an order had to be rebuilt from the payment alone, so the
    // dashboard can surface it as needing attention.
    needsReview: metaValue(order.meta_data, "_sba_needs_review") === "yes",

    trackingUrl: extractTrackingUrl(order.meta_data),
    trackingCode:
      metaValue(order.meta_data, "ywot_tracking_code") ||
      metaValue(order.meta_data, "_delhivery_awb") ||
      "",
    carrierName: metaValue(order.meta_data, "ywot_carrier_name") || "",
    pickUpDate: metaValue(order.meta_data, "ywot_pick_up_date") || "",
    pickedUp: metaValue(order.meta_data, "ywot_picked_up") === "yes",
  };
}

export async function listWooOrders({
  page = 1,
  perPage = 50,
  after,
  before,
  status,
  search,
} = {}) {
  const params = new URLSearchParams({
    page: String(Math.max(1, page)),
    per_page: String(Math.min(100, Math.max(1, perPage))),
    orderby: "date",
    order: "desc",
  });
  if (after) params.set("after", after);
  if (before) params.set("before", before);
  if (status && status !== "any") params.set("status", status);
  if (search) params.set("search", search);

  const res = await wcFetchRaw(`/orders?${params.toString()}`);
  const total = Number(res.headers.get("X-WP-Total") || 0);
  const totalPages = Number(res.headers.get("X-WP-TotalPages") || 1);
  const data = await res.json();

  return { orders: (data || []).map(mapAdminOrder), total, totalPages };
}

// Statuses an admin is allowed to move an order to. Anything outside this list
// is rejected rather than passed through to WooCommerce, so a malformed or
// hostile request can't park an order in an unknown state.
// WooCommerce's seven core statuses, plus the two this shop needs.
//
// There was no way to say an order had been sent. The only forward step was
// "completed", so dispatching a parcel told the customer it was finished and
// told WooCommerce a cash-on-delivery order had been paid. Shipping and
// delivery are separate events from completion and now have their own words.
//
// "shipped" and "delivered" are registered in WordPress by a snippet; until
// that is in place WooCommerce rejects them, which is why they are listed
// separately and reported clearly rather than failing as an unknown status.
export const CORE_ORDER_STATUSES = [
  "pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed",
];

export const CUSTOM_ORDER_STATUSES = ["shipped", "delivered"];

export const ALLOWED_ORDER_STATUSES = [...CORE_ORDER_STATUSES, ...CUSTOM_ORDER_STATUSES];

// Courier meta is written with the same ywot_* keys the YITH Order Tracking
// plugin uses, so anything set here shows up in wp-admin exactly as if it had
// been typed there — and the storefront's "Track" button picks it up unchanged.
//
// This is also the seam for a future courier API (Amazon Shipping, Delhivery's
// own API, etc.): an integration would create the shipment, then call straight
// into updateWooOrder with the carrier name / tracking number / tracking URL it
// got back. Nothing above this function needs to know which of the two paths —
// typed by hand or returned by an API — produced the values.
const TRACKING_META_KEYS = {
  carrierName: "ywot_carrier_name",
  trackingCode: "ywot_tracking_code",
  carrierUrl: "ywot_carrier_url",
  pickUpDate: "ywot_pick_up_date",
  // The "Order picked up by Carrier" switch in wp-admin. YITH stores it as the
  // string "yes"/"no", not a boolean, and it is what gates the tracking details
  // being shown to the customer at all.
  pickedUp: "ywot_picked_up",
};

// The fields of an address the dashboard may change. Anything else on the
// order — totals, line items, payment — is deliberately not editable here.
const ADDRESS_FIELDS = [
  "first_name", "last_name", "company", "address_1", "address_2",
  "city", "state", "postcode", "country", "phone", "email",
];

function addressPayload(input) {
  const out = {};
  for (const f of ADDRESS_FIELDS) {
    // Only fields actually supplied are sent, so a partial edit cannot blank
    // the rest of the address.
    if (input[f] !== undefined) out[f] = String(input[f] ?? "").slice(0, 200);
  }
  return out;
}

export async function updateWooOrder(orderId, { status, tracking, markPaid, billing, shipping } = {}) {
  const payload = {};

  // A delivery address is wrong often enough — a missed flat number, a wrong
  // pin code — that correcting it had to mean opening wp-admin. An order the
  // courier cannot deliver is a parcel shipped twice.
  if (billing && typeof billing === "object") {
    const a = addressPayload(billing);
    if (Object.keys(a).length) payload.billing = a;
  }
  if (shipping && typeof shipping === "object") {
    const a = addressPayload(shipping);
    // WooCommerce has no email or phone on a shipping address.
    delete a.email;
    if (Object.keys(a).length) payload.shipping = a;
  }

  // Recording that cash was collected, and nothing else.
  //
  // Deliberately separate from the status. Moving a COD order to "completed"
  // is what WooCommerce treats as payment today, which is why dispatching one
  // marked it paid before the money existed. Payment is its own fact: the
  // courier handed over cash, which may happen days after dispatch and may
  // never happen at all.
  //
  // Only ever sets paid, never unsets it. Reversing a payment is a refund,
  // which has its own record, and a bulk action must not be able to erase one.
  if (markPaid === true) payload.set_paid = true;

  if (status) {
    if (!ALLOWED_ORDER_STATUSES.includes(status)) {
      throw new Error(`Unsupported order status: ${status}`);
    }
    payload.status = status;
  }

  if (tracking && typeof tracking === "object") {
    const meta = Object.entries(TRACKING_META_KEYS)
      // undefined means "leave alone"; empty string means "clear this field".
      .filter(([field]) => tracking[field] !== undefined)
      .map(([field, key]) => ({
        key,
        value:
          field === "pickedUp"
            ? (tracking[field] ? "yes" : "no")
            : String(tracking[field] ?? "").slice(0, 500),
      }));
    if (meta.length) payload.meta_data = meta;
  }

  if (!Object.keys(payload).length) throw new Error("Nothing to update");

  let order;
  try {
    order = await wcFetch(`/orders/${orderId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // WooCommerce refuses a status it does not know about. Saying which
    // snippet is missing is more use than relaying "invalid parameter".
    if (CUSTOM_ORDER_STATUSES.includes(payload.status) && /status/i.test(err.message)) {
      throw Object.assign(
        new Error(
          `WooCommerce does not know the "${payload.status}" status yet. ` +
          "Add the order-status snippet in wp-admin (Snippets) and try again.",
        ),
        { status: 400 },
      );
    }
    throw err;
  }
  return mapAdminOrder(order);
}

export async function addWooOrderNote(orderId, note, { customerNote = false } = {}) {
  const created = await wcFetch(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({ note: String(note).slice(0, 2000), customer_note: Boolean(customerNote) }),
  });
  return {
    id: created.id,
    author: created.author,
    dateCreated: created.date_created,
    note: created.note,
    isCustomerNote: Boolean(created.customer_note),
  };
}

// Pulls every order in a date window, a page at a time.
//
// Analytics has to count all of them — computing totals from whatever the table
// happened to have loaded would report "revenue among the last 100 orders" while
// calling it revenue. The ceiling stops a careless date range from walking the
// entire order history in one request.
export async function fetchOrdersInRange({ after, before, maxOrders = 5000 }) {
  const collected = [];
  let page = 1;

  while (collected.length < maxOrders) {
    const params = new URLSearchParams({
      page: String(page),
      per_page: "100",
      orderby: "date",
      order: "desc",
      status: "any",
    });
    if (after) params.set("after", after);
    if (before) params.set("before", before);

    const res = await wcFetchRaw(`/orders?${params.toString()}`);
    const totalPages = Number(res.headers.get("X-WP-TotalPages") || 1);
    const batch = await res.json();
    if (!batch?.length) break;

    collected.push(...batch.map(mapAdminOrder));
    if (page >= totalPages) break;
    page += 1;
  }

  return collected;
}

// Order notes are a separate endpoint (one request per order), so they're only
// fetched when an admin actually opens a single order's detail view.
export async function getWooOrderNotes(orderId) {
  const notes = await wcFetch(`/orders/${orderId}/notes`);
  return (notes || []).map((n) => ({
    id: n.id,
    author: n.author,
    dateCreated: n.date_created,
    note: n.note,
    isCustomerNote: Boolean(n.customer_note),
  }));
}
