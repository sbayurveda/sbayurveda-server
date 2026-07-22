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

export async function createWooOrder({ pricedItems, customer, paymentMethod, paymentTitle, setPaid, status, metaData }) {
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
      meta_data: metaData || [],
    }),
  });

  return { id: order.id, number: order.number, total: order.total };
}
