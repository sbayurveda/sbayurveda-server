// Creating and repairing products from our own dashboard, so adding stock never
// means opening wp-admin.
//
// Two different credentials are needed, for two different APIs:
//
//   - WooCommerce (wc/v3) takes the consumer key this server already uses for
//     orders. That covers everything about a product except its image bytes.
//   - The WordPress media library (wp/v2/media) does not accept a WooCommerce
//     key at all. It needs a WordPress user, which is what WP_APP_USER and
//     WP_APP_PASSWORD are: an Application Password, revocable on its own
//     without disturbing the account's real password.
//
// Without the media credential the dashboard still works — it just can't take a
// file off someone's computer, so images have to arrive as URLs for WooCommerce
// to fetch itself.

const WC_BASE_URL = process.env.WC_BASE_URL || "https://sbayurveda.com";
const WP_APP_USER = process.env.WP_APP_USER || "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";

export function mediaUploadConfigured() {
  return Boolean(WP_APP_USER && WP_APP_PASSWORD);
}

function wpAuthHeader() {
  // Application Passwords are issued with spaces for readability; WordPress
  // expects them without.
  const pass = WP_APP_PASSWORD.replace(/\s+/g, "");
  return `Basic ${Buffer.from(`${WP_APP_USER}:${pass}`).toString("base64")}`;
}

// A filename WordPress will accept, derived from the product it belongs to, so
// the media library stays searchable and the URL is a small SEO win over
// IMG_4821.jpg.
export function mediaFilename(productName, originalName) {
  const ext = (String(originalName || "").match(/\.(jpe?g|png|webp|gif|avif)$/i) || [, "jpg"])[1].toLowerCase();
  const base = String(productName || "product")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "product";
  return `${base}.${ext === "jpeg" ? "jpg" : ext}`;
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Puts one image into the WordPress media library and returns what WooCommerce
// needs to attach it.
export async function uploadProductImage({ base64, filename, contentType, productName, altText }) {
  if (!mediaUploadConfigured()) {
    throw Object.assign(new Error("Image upload isn't configured on the server yet."), { status: 503 });
  }
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw Object.assign(new Error("Images must be JPG, PNG, WebP, GIF or AVIF."), { status: 400 });
  }

  const bytes = Buffer.from(String(base64 || ""), "base64");
  if (!bytes.length) throw Object.assign(new Error("That image was empty."), { status: 400 });
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error("Images must be 8MB or smaller."), { status: 400 });
  }

  const name = mediaFilename(productName, filename);
  const res = await fetch(`${WC_BASE_URL}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: wpAuthHeader(),
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${name}"`,
    },
    body: bytes,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`WordPress refused the image (${res.status}): ${body.slice(0, 200)}`),
      { status: 502 },
    );
  }

  const media = await res.json();
  // Alt text is what a screen reader announces and what Google reads off an
  // image; WordPress won't set it from the upload alone.
  if (altText) {
    await fetch(`${WC_BASE_URL}/wp-json/wp/v2/media/${media.id}`, {
      method: "POST",
      headers: { Authorization: wpAuthHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ alt_text: String(altText).slice(0, 200) }),
    }).catch(() => {}); // a missing alt is not worth failing an upload over
  }

  return { id: media.id, src: media.source_url };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

const CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;

async function wcFetch(path, options = {}) {
  const res = await fetch(`${WC_BASE_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64")}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`WooCommerce API ${res.status}: ${body.slice(0, 300)}`),
      { status: res.status === 400 ? 400 : 502 },
    );
  }
  return res.json();
}

// The storefront drops any product with no price, no image, or not purchasable
// (see mapWooProduct) — it would otherwise render a blank tile in a shop
// selling medicine, which is a trust problem. So a product saved from here is
// only actually for sale once it has all three, and the dashboard says so
// rather than letting someone believe they have published something.
export function missingForStorefront(product) {
  const missing = [];
  if (!Number(product.regular_price) && !Number(product.price)) missing.push("price");
  if (!(product.images || []).length) missing.push("image");
  if (!String(product.description || "").trim() && !String(product.short_description || "").trim()) {
    missing.push("description");
  }
  return missing;
}

function toWooPayload(input) {
  const payload = {
    name: String(input.name || "").trim(),
    type: "simple",
    status: input.status === "draft" ? "draft" : "publish",
    regular_price: input.mrp != null ? String(input.mrp) : undefined,
    sale_price: input.price != null && Number(input.price) > 0 ? String(input.price) : undefined,
    description: input.description ?? undefined,
    short_description: input.shortDescription ?? undefined,
    sku: input.sku ? String(input.sku).trim() : undefined,
    manage_stock: input.stockQty != null,
    stock_quantity: input.stockQty != null ? Number(input.stockQty) : undefined,
    stock_status: input.inStock === false ? "outofstock" : "instock",
    categories: Array.isArray(input.categoryIds) ? input.categoryIds.map((id) => ({ id: Number(id) })) : undefined,
    brands: Array.isArray(input.brandIds) ? input.brandIds.map((id) => ({ id: Number(id) })) : undefined,
    images: Array.isArray(input.images)
      ? input.images.map((img) => (img.id ? { id: Number(img.id) } : { src: String(img.src) }))
      : undefined,
    meta_data: input.hsn !== undefined
      ? [{ key: "_hsn_code", value: String(input.hsn).trim() }]
      : undefined,
  };

  // WooCommerce treats a present-but-undefined key differently from an absent
  // one on an update: sending undefined can blank a field we meant to leave.
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }
  return payload;
}

export async function createWooProduct(input) {
  if (!String(input.name || "").trim()) {
    throw Object.assign(new Error("A product needs a name."), { status: 400 });
  }
  const created = await wcFetch("/products", { method: "POST", body: JSON.stringify(toWooPayload(input)) });
  return mapAdminProduct(created);
}

export async function updateWooProduct(id, input) {
  const updated = await wcFetch(`/products/${Number(id)}`, {
    method: "PUT",
    body: JSON.stringify(toWooPayload(input)),
  });
  return mapAdminProduct(updated);
}

// WooCommerce has no HSN field of its own, so it lives in meta. The tax
// report needs one per product to pick a GST rate; without it everything
// falls back to 3004 (ayurvedic medicaments, 5%), which covered 506 of the
// 507 lines in the reference month.
function metaValue(meta, key) {
  return (meta || []).find((m) => m.key === key)?.value ?? "";
}

export function mapAdminProduct(p) {
  return {
    hsn: String(metaValue(p.meta_data, "_hsn_code") || ""),
    id: p.id,
    name: p.name,
    slug: p.slug,
    status: p.status,
    permalink: p.permalink,
    sku: p.sku || "",
    price: Number(p.price || 0),
    regularPrice: Number(p.regular_price || 0),
    salePrice: Number(p.sale_price || 0),
    stockStatus: p.stock_status,
    stockQty: p.stock_quantity,
    description: p.description || "",
    shortDescription: p.short_description || "",
    categories: (p.categories || []).map((c) => ({ id: c.id, name: c.name })),
    brands: (p.brands || []).map((b) => ({ id: b.id, name: b.name })),
    images: (p.images || []).map((i) => ({ id: i.id, src: i.src, alt: i.alt || "" })),
    missing: missingForStorefront(p),
  };
}

// Products the storefront is currently refusing to show, newest first. This is
// the repair queue: every row here is something a customer cannot buy.
export async function listProductsNeedingWork({ page = 1, perPage = 20, need = "any" } = {}) {
  const products = await wcFetch(
    `/products?per_page=${Math.min(Number(perPage) || 20, 100)}&page=${Number(page) || 1}` +
    `&status=publish&orderby=date&order=desc`,
  );
  const mapped = products.map(mapAdminProduct);
  const wanted = mapped.filter((p) => {
    if (!p.missing.length) return false;
    if (need === "any") return true;
    return p.missing.includes(need);
  });
  return { products: wanted, scanned: mapped.length };
}

export async function listTaxonomy(kind) {
  const path = kind === "brands" ? "/products/brands" : "/products/categories";
  const rows = await wcFetch(`${path}?per_page=100&orderby=name&order=asc`);
  return rows.map((r) => ({ id: r.id, name: r.name, count: r.count }));
}
