// Creating and repairing products from our own dashboard, so adding stock never
// means opening wp-admin.

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const WC_BASE_URL = process.env.WC_BASE_URL || "https://sbayurveda.com";
const CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;

// Where WooCommerce comes to collect a staged upload. Must be reachable from
// the WordPress host — the one requirement this approach has.
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "https://api.sbayurveda.com").replace(/\/$/, "");
//
// Images never touch wp-admin and need no WordPress login.
//
// The obvious route — POST the file to /wp-json/wp/v2/media — refuses a
// WooCommerce key outright and wants a WordPress user, which would mean
// creating and holding an Application Password. WooCommerce offers a second
// door: give it an image URL and it fetches the file into its own media
// library itself, authenticated by the same consumer key this server already
// uses for orders.
//
// So an upload lands here first, is served at a public URL, and WooCommerce
// pulls it across when the product is saved. Our copy is a staging post, not
// storage: WordPress ends up with the real file, and the stale copies here
// are swept after a week.

// Always true now: no credential is involved. Kept so the dashboard has one
// thing to ask rather than assuming.
export function mediaUploadConfigured() {
  return true;
}

// A filename WordPress will accept, derived from the product it belongs to, so
// the media library stays searchable and the URL is a small SEO win over
// IMG_4821.jpg.
//
// `ext`, when given, comes from sniffing the actual bytes and overrides whatever
// the filename claimed. WordPress checks that a file's extension agrees with its
// contents and refuses the upload when they disagree, so a PNG arriving as
// "photo.jpg" has to be staged as .png or WooCommerce will not take it.
export function mediaFilename(productName, originalName, ext) {
  const fromName = (String(originalName || "").match(/\.(jpe?g|png|webp|gif|avif)$/i) || [, "jpg"])[1];
  const chosen = String(ext || fromName).toLowerCase();
  const base = String(productName || "product")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "product";
  return `${base}.${chosen === "jpeg" ? "jpg" : chosen}`;
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// What the file actually IS, rather than what the browser said it was.
//
// The content type the browser reports is a claim with no evidence behind it: a
// file dragged from Finder can arrive as "" or as "image/png;charset=binary",
// and either way the old exact-match check refused a perfectly good photograph.
// Worse, a mislabelled file that passed the check was staged under the wrong
// extension and WordPress then rejected it on arrival. The first twelve bytes
// settle the question, so they are what we read.
const MAGIC = [
  { type: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/png", ext: "png", test: (b) => b.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n" },
  { type: "image/gif", ext: "gif", test: (b) => b.toString("latin1", 0, 4) === "GIF8" },
  {
    type: "image/webp",
    ext: "webp",
    test: (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
  },
];

// AVIF and HEIC share the ISO base-media container; only the brand tells them
// apart, and the difference matters because WordPress publishes one and not the
// other.
const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

function ftypBrand(bytes) {
  if (bytes.length < 12 || bytes.toString("latin1", 4, 8) !== "ftyp") return "";
  return bytes.toString("latin1", 8, 12).toLowerCase();
}

/**
 * Identifies an image from its own bytes.
 *
 * Returns { type, ext } for something we can publish, { heic: true } for an
 * iPhone photo that has to be converted first, or null for anything else.
 */
export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  for (const m of MAGIC) {
    if (m.test(bytes)) return { type: m.type, ext: m.ext };
  }
  const brand = ftypBrand(bytes);
  if (AVIF_BRANDS.has(brand)) return { type: "image/avif", ext: "avif" };
  if (HEIF_BRANDS.has(brand)) return { heic: true };
  return null;
}

// Puts one image into the WordPress media library and returns what WooCommerce
// needs to attach it.
export const MEDIA_DIR = process.env.MEDIA_DIR
  || path.join(process.env.STORE_DIR || path.join(os.tmpdir(), "sba-store"), "media");

// Keeps a staged file to a name that cannot escape the directory, whatever
// the browser sent as a filename.
export function mediaPathFor(id) {
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, "");
  if (!safe || safe.includes("..")) return null;
  return path.join(MEDIA_DIR, safe);
}

/**
 * Stages one image and returns the URL WooCommerce should fetch it from.
 *
 * The product name is worked into the filename so the media library stays
 * searchable and the public URL reads as something rather than IMG_4821.
 */
export async function uploadProductImage({ base64, filename, productName }) {
  const bytes = Buffer.from(String(base64 || ""), "base64");
  if (!bytes.length) throw Object.assign(new Error("That image was empty."), { status: 400 });
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error("Images must be 8MB or smaller."), { status: 400 });
  }

  const sniffed = sniffImage(bytes);
  // Said separately from the generic refusal because the fix is different: an
  // iPhone photo is a real photograph that simply needs converting, and the
  // dashboard converts it in the browser before sending. Reaching here means
  // that conversion did not happen, so say what to do about it.
  if (sniffed?.heic) {
    throw Object.assign(
      new Error(
        "That is an iPhone HEIC photo, which WordPress cannot publish. " +
        "Open it in Preview and export it as JPEG, or turn on " +
        "Settings \u2192 Camera \u2192 Formats \u2192 Most Compatible on the phone.",
      ),
      { status: 400 },
    );
  }
  if (!sniffed) {
    throw Object.assign(
      new Error("Images must be JPG, PNG, WebP, GIF or AVIF \u2014 that file's contents are none of those."),
      { status: 400 },
    );
  }

  const named = mediaFilename(productName, filename, sniffed.ext);
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}-${named}`;
  const target = mediaPathFor(id);
  if (!target) throw Object.assign(new Error("Bad filename."), { status: 400 });

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(target, bytes, { mode: 0o644 });

  // Deliberately not called `id`. A WooCommerce image id is an attachment id,
  // an integer; this is a staging filename. Naming it `id` made every caller
  // treat it as one — the browser sent {id: "mv...-photo.jpg"} instead of the
  // src, and WooCommerce answered "images[0][id] is not of type integer",
  // which is why no upload ever completed.
  return { stagedAs: id, src: `${PUBLIC_BASE}/media/${id}`, bytes: bytes.length };
}

// WooCommerce has its own copy within seconds of a product being saved, so
// the staged file is only needed until then. A week is generous.
const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function cleanupMedia() {
  try {
    const now = Date.now();
    let removed = 0;
    for (const name of fs.readdirSync(MEDIA_DIR)) {
      const file = path.join(MEDIA_DIR, name);
      if (now - fs.statSync(file).mtimeMs > MEDIA_MAX_AGE_MS) {
        fs.unlinkSync(file);
        removed += 1;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

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

// `creating` decides what an omitted field means. On a new product the
// defaults below are what a simple published product needs. On an update an
// omitted field must be left alone — and five of them were not:
//
//   name         absent -> "" would blank the product's name
//   status       absent -> "publish" would PUBLISH a draft
//   stock_status absent -> "instock" would put a sold-out product back on sale
//   manage_stock absent -> false would discard stock tracking
//   type         absent -> "simple" would flatten a variable product
//
// The dashboard form always sends every field, so this never bit in the UI,
// but any partial update would have done real damage.
export function toWooPayload(input, { creating = false } = {}) {
  const has = (key) => input[key] !== undefined;
  const payload = {
    name: has("name") ? String(input.name).trim() : (creating ? "" : undefined),
    type: creating ? "simple" : undefined,
    status: has("status")
      ? (input.status === "draft" ? "draft" : "publish")
      : (creating ? "publish" : undefined),
    regular_price: input.mrp != null ? String(input.mrp) : undefined,
    sale_price: input.price != null && Number(input.price) > 0 ? String(input.price) : undefined,
    description: input.description ?? undefined,
    short_description: input.shortDescription ?? undefined,
    sku: input.sku ? String(input.sku).trim() : undefined,
    manage_stock: has("stockQty") ? input.stockQty != null : (creating ? false : undefined),
    stock_quantity: input.stockQty != null ? Number(input.stockQty) : undefined,
    stock_status: has("inStock")
      ? (input.inStock === false ? "outofstock" : "instock")
      : (creating ? "instock" : undefined),
    categories: Array.isArray(input.categoryIds) ? input.categoryIds.map((id) => ({ id: Number(id) })) : undefined,
    brands: Array.isArray(input.brandIds) ? input.brandIds.map((id) => ({ id: Number(id) })) : undefined,
    // An existing library image is referenced by its attachment id; anything
    // else must go as a src for WooCommerce to fetch. `Number(img.id)` on a
    // non-numeric id yields NaN, which JSON writes as null, and the whole
    // request is rejected — so the id has to prove itself an integer.
    images: Array.isArray(input.images)
      ? input.images.map((img) => {
          const id = Number(img.id);
          return Number.isInteger(id) && id > 0 ? { id } : { src: String(img.src || "") };
        })
      : undefined,
    meta_data: (() => {
      const meta = [];
      if (input.hsn !== undefined) meta.push({ key: "_hsn_code", value: String(input.hsn).trim() });
      if (input.codDisabled !== undefined) {
        meta.push({ key: "_sba_cod_disabled", value: input.codDisabled ? "yes" : "no" });
      }
      return meta.length ? meta : undefined;
    })(),
  };

  // WooCommerce treats a present-but-undefined key differently from an absent
  // one on an update: sending undefined can blank a field we meant to leave.
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }
  return payload;
}

// WooCommerce fetches staged images over HTTP, and a fetch that fails is not
// an error — the product saves with no picture and the shop then hides it.
// Asking for images and getting none back is worth saying out loud.
function imageWarning(input, saved) {
  const asked = (input.images || []).length;
  if (asked && !(saved.images || []).length) {
    return "Saved, but WooCommerce could not collect the image. Check that it can reach this server.";
  }
  return null;
}

export async function createWooProduct(input) {
  if (!String(input.name || "").trim()) {
    throw Object.assign(new Error("A product needs a name."), { status: 400 });
  }
  const created = await wcFetch("/products", {
    method: "POST",
    body: JSON.stringify(toWooPayload(input, { creating: true })),
  });
  const product = mapAdminProduct(created);
  return { ...product, warning: imageWarning(input, product) };
}

export async function updateWooProduct(id, input) {
  const updated = await wcFetch(`/products/${Number(id)}`, {
    method: "PUT",
    body: JSON.stringify(toWooPayload(input)),
  });
  const product = mapAdminProduct(updated);
  return { ...product, warning: imageWarning(input, product) };
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
    // Off means this product can only be bought by paying online, and any cart
    // holding it loses the option.
    codDisabled: metaValue(p.meta_data, "_sba_cod_disabled") === "yes",
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

/**
 * Switches cash on delivery on or off for many products at once.
 *
 * WooCommerce takes 100 products per batch call, so a change across the whole
 * catalogue is fifteen requests rather than fifteen hundred — at roughly a
 * second each that is the difference between a quarter of a minute and half an
 * hour.
 *
 * Batches are sent one after another, not in parallel: six concurrent writes
 * into a WordPress on shared hosting is how you take the storefront down with
 * your own admin action.
 */
export async function setCodForProducts(ids, codDisabled) {
  const unique = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (!unique.length) return { updated: 0, products: [] };
  if (unique.length > 2000) {
    throw Object.assign(new Error("That is more products than one change should touch."), { status: 400 });
  }

  const value = codDisabled ? "yes" : "no";
  const products = [];
  for (let i = 0; i < unique.length; i += 100) {
    const slice = unique.slice(i, i + 100);
    const res = await wcFetch("/products/batch", {
      method: "POST",
      body: JSON.stringify({
        update: slice.map((id) => ({ id, meta_data: [{ key: "_sba_cod_disabled", value }] })),
      }),
    });
    products.push(...(res.update || []).map(mapAdminProduct));
  }
  return { updated: products.length, products };
}

/**
 * Stamps an HSN code onto many products at once.
 *
 * The tax report falls back to 3004 when a product has no code, so the figures
 * were already right — but the fallback is invisible, and an accountant
 * checking a product one by one found the field empty. Writing it makes the
 * catalogue say what the return assumes.
 *
 * Batched and serial for the same reason as the COD switch: a hundred per call,
 * one call at a time, so a catalogue-wide change does not take the shop down.
 */
export async function setHsnForProducts(ids, hsn) {
  const code = String(hsn ?? "").trim();
  if (!/^[0-9]{4,8}$/.test(code)) {
    throw Object.assign(new Error("An HSN code is four to eight digits."), { status: 400 });
  }
  const unique = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (!unique.length) return { updated: 0, products: [] };
  if (unique.length > 2000) {
    throw Object.assign(new Error("That is more products than one change should touch."), { status: 400 });
  }

  const products = [];
  for (let i = 0; i < unique.length; i += 100) {
    const res = await wcFetch("/products/batch", {
      method: "POST",
      body: JSON.stringify({
        update: unique.slice(i, i + 100).map((id) => ({
          id, meta_data: [{ key: "_hsn_code", value: code }],
        })),
      }),
    });
    products.push(...(res.update || []).map(mapAdminProduct));
  }
  return { updated: products.length, products };
}
