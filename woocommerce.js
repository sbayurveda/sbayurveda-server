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

async function wcFetch(path, options = {}) {
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
