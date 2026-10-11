// A local copy of the catalogue and the order book.
//
// Every dashboard screen used to call WooCommerce live, and WordPress costs
// about 0.68s to answer anything at all before it does a scrap of work — with
// roughly forty plugins loading on each request. That is why the orders page
// stopped at 100 rows and the product repair queue crawled twenty at a time:
// not a design choice, a budget.
//
// So the bridge keeps its own copy, refreshed in the background, and the
// dashboard reads from memory. All 1,447 products and every order since the
// shop opened, searchable at once.
//
// WooCommerce stays the system of record. Writes still go there first; the
// local copy is updated the moment one succeeds, so a screen never shows a
// change that did not land. Nothing here is a source of truth — delete the
// snapshots and the next sync rebuilds them.

import fs from "fs";
import path from "path";
import os from "os";
import { mapAdminOrder } from "./woocommerce.js";
import { mapAdminProduct } from "./products.js";

// Deploys replace the app directory, so this lives outside it.
const DIR = process.env.STORE_DIR || path.join(os.tmpdir(), "sba-store");
const WC_BASE_URL = process.env.WC_BASE_URL || "https://sbayurveda.com";
const CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;

const PER_PAGE = 100;        // WooCommerce's own ceiling
const MAX_PAGES = 200;       // a stop, so a paging bug cannot walk forever
const SYNC_INTERVAL_MS = Number(process.env.STORE_SYNC_MS || 10 * 60 * 1000);

const state = {
  products: [],
  orders: [],
  productById: new Map(),
  orderById: new Map(),
  syncedAt: { products: null, orders: null },
  syncing: false,
  lastError: null,
};

// --- disk ------------------------------------------------------------------

function file(name) {
  return path.join(DIR, `${name}.json`);
}

function writeSnapshot(name, rows) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const target = file(name);
    const tmp = `${target}.${process.pid}.tmp`;
    // Write-then-rename: a crash mid-write must not leave a half-parsed file
    // that the next boot would read as an empty catalogue.
    fs.writeFileSync(tmp, JSON.stringify({ rows, syncedAt: Date.now() }), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error(`store: could not save ${name}:`, err.message);
  }
}

function readSnapshot(name) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(name), "utf8"));
    return Array.isArray(parsed.rows) ? parsed : null;
  } catch {
    return null;
  }
}

// --- WooCommerce -----------------------------------------------------------

async function wcGet(pathname) {
  const res = await fetch(`${WC_BASE_URL}/wp-json/wc/v3${pathname}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64")}`,
    },
  });
  if (!res.ok) throw new Error(`WooCommerce ${res.status} on ${pathname}`);
  return { rows: await res.json(), totalPages: Number(res.headers.get("x-wp-totalpages") || 1) };
}

// Walks every page of a collection. Serial on purpose: six parallel requests
// into a WordPress on shared hosting is how you take the storefront down with
// your own background job.
async function fetchAll(base, label) {
  const out = [];
  let page = 1;
  let totalPages = 1;
  while (page <= Math.min(totalPages, MAX_PAGES)) {
    const sep = base.includes("?") ? "&" : "?";
    const { rows, totalPages: tp } = await wcGet(`${base}${sep}per_page=${PER_PAGE}&page=${page}`);
    totalPages = tp;
    out.push(...rows);
    if (!rows.length) break;
    page += 1;
  }
  if (page > MAX_PAGES) console.error(`store: ${label} hit the page ceiling at ${MAX_PAGES}`);
  return out;
}

function index(rows) {
  const map = new Map();
  for (const row of rows) map.set(String(row.id), row);
  return map;
}

// --- sync ------------------------------------------------------------------

export async function syncProducts() {
  const raw = await fetchAll("/products?status=any&orderby=id&order=asc", "products");
  state.products = raw.map(mapAdminProduct);
  state.productById = index(state.products);
  state.syncedAt.products = Date.now();
  writeSnapshot("products", state.products);
  return state.products.length;
}

export async function syncOrders() {
  const raw = await fetchAll("/orders?status=any&orderby=date&order=desc", "orders");
  state.orders = raw.map(mapAdminOrder);
  state.orderById = index(state.orders);
  state.syncedAt.orders = Date.now();
  writeSnapshot("orders", state.orders);
  return state.orders.length;
}

export async function syncAll({ reason = "scheduled" } = {}) {
  if (state.syncing) return { skipped: "already running" };
  state.syncing = true;
  const started = Date.now();
  try {
    const products = await syncProducts();
    const orders = await syncOrders();
    state.lastError = null;
    console.log(`store: synced ${products} products and ${orders} orders in ${Date.now() - started}ms (${reason})`);
    return { products, orders, ms: Date.now() - started };
  } catch (err) {
    // A failed sync leaves the previous copy in place. Stale data beats an
    // empty dashboard, and the status endpoint reports how old it is.
    state.lastError = err.message;
    console.error("store: sync failed:", err.message);
    return { error: err.message };
  } finally {
    state.syncing = false;
  }
}

// Loads whatever the last run left on disk, then refreshes in the background.
// The dashboard is usable within milliseconds of a restart instead of waiting
// out a full crawl of WooCommerce.
export function startStore() {
  for (const name of ["products", "orders"]) {
    const snap = readSnapshot(name);
    if (!snap) continue;
    state[name] = snap.rows;
    state[name === "products" ? "productById" : "orderById"] = index(snap.rows);
    state.syncedAt[name] = snap.syncedAt;
  }
  console.log(`store: loaded ${state.products.length} products, ${state.orders.length} orders from disk`);

  syncAll({ reason: "startup" });
  const timer = setInterval(() => syncAll({ reason: "scheduled" }), SYNC_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

// --- reads -----------------------------------------------------------------

export function storeStatus() {
  return {
    products: state.products.length,
    orders: state.orders.length,
    syncedAt: state.syncedAt,
    syncing: state.syncing,
    lastError: state.lastError,
    stale: Object.values(state.syncedAt).some((t) => !t || Date.now() - t > SYNC_INTERVAL_MS * 3),
  };
}

export function allProducts() {
  return state.products;
}

export function allOrders() {
  return state.orders;
}

export function getProduct(id) {
  return state.productById.get(String(id)) || null;
}

export function getOrder(id) {
  return state.orderById.get(String(id)) || null;
}

// Applied after a successful write to WooCommerce, so the dashboard reflects
// the change without waiting for the next sync.
export function upsertProduct(product) {
  if (!product?.id) return;
  const i = state.products.findIndex((p) => p.id === product.id);
  if (i >= 0) state.products[i] = product;
  else state.products.unshift(product);
  state.productById.set(String(product.id), product);
  writeSnapshot("products", state.products);
}

export function upsertOrder(order) {
  if (!order?.id) return;
  const i = state.orders.findIndex((o) => o.id === order.id);
  if (i >= 0) state.orders[i] = order;
  else state.orders.unshift(order);
  state.orderById.set(String(order.id), order);
  writeSnapshot("orders", state.orders);
}

// Test seam: lets the suite load a known catalogue without a network.
export function _seed({ products = [], orders = [] } = {}) {
  state.products = products;
  state.orders = orders;
  state.productById = index(products);
  state.orderById = index(orders);
  state.syncedAt = { products: Date.now(), orders: Date.now() };
}
