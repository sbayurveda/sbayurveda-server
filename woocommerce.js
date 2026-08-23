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

// Fetches current, authoritative prices for a set of cart items directly
// from WooCommerce (via its public Store API, no auth needed for reads) and
// computes the trusted order totals server-side.
export async function priceCartItems(items) {
  const priced = [];
  for (const item of items) {
    const wcId = toWcId(item.id);
    const res = await fetch(`${WC_BASE_URL}/wp-json/wc/store/v1/products/${wcId}`);
    if (!res.ok) throw new Error(`Product ${wcId} not found or unavailable`);
    const product = await res.json();
    if (!product.is_purchasable) throw new Error(`Product ${wcId} is no longer purchasable`);
    // is_purchasable stays true even when a product is out of stock — it only
    // reflects that the product exists/is published, not stock status. This
    // check is what actually stops a customer from being charged for
    // something we can't fulfill.
    if (!product.is_in_stock) throw new Error(`${product.name} is currently out of stock`);
    const price = Number(product.prices.price) / 100;
    const mrp = Number(product.prices.regular_price) / 100;
    const qty = Math.max(1, Math.floor(Number(item.qty) || 1));
    priced.push({ wcId, name: product.name, price, mrp, qty });
  }
  const subtotal = priced.reduce((sum, i) => sum + i.price * i.qty, 0);
  const mrpTotal = priced.reduce((sum, i) => sum + i.mrp * i.qty, 0);
  return { items: priced, subtotal, mrpTotal, savings: mrpTotal - subtotal };
}

function splitName(fullName) {
  const parts = (fullName || "").trim().split(/\s+/);
  return { first_name: parts[0] || "", last_name: parts.slice(1).join(" ") || "" };
}

export async function createWooOrder({ pricedItems, customer, paymentMethod, paymentTitle, setPaid, status, shippingFee, codFee, coupon, metaData }) {
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
      billing: address,
      shipping: address,
      line_items: pricedItems.items.map((i) => ({ product_id: i.wcId, quantity: i.qty })),
      shipping_lines: shippingFee
        ? [{ method_id: "flat_rate", method_title: "Delivery Charges", total: String(shippingFee) }]
        : [],
      fee_lines: [
        ...(codFee ? [{ name: "Cash on Delivery Fee", total: String(codFee) }] : []),
        ...(coupon?.valid && coupon.discount > 0
          ? [{ name: `Discount (${coupon.code})`, total: String(-coupon.discount) }]
          : []),
      ],
      meta_data: metaData || [],
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

    trackingUrl: extractTrackingUrl(order.meta_data),
    trackingCode:
      metaValue(order.meta_data, "ywot_tracking_code") ||
      metaValue(order.meta_data, "_delhivery_awb") ||
      "",
    carrierName: metaValue(order.meta_data, "ywot_carrier_name") || "",
    pickUpDate: metaValue(order.meta_data, "ywot_pick_up_date") || "",
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
