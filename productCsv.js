// The catalogue as a spreadsheet, and back again.
//
// Exporting is the easy half. Importing is a bulk write over a live shop, so
// the rules here are deliberately cautious:
//
//   - a row is matched to an existing product by id, then by SKU; anything
//     else is a new product
//   - a column that is absent from the file is not a change. Only columns
//     actually present are written, so a file holding just id and price
//     cannot blank every description in the shop
//   - a row that cannot be understood is reported with its line number and
//     skipped, rather than failing the whole file or being guessed at

import { DEFAULT_HSN } from "./gst.js";

export const EXPORT_COLUMNS = [
  "id", "sku", "name", "status", "mrp", "price", "stock", "quantity",
  "hsn", "cod", "categories", "brands", "short_description", "description", "images",
];

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function productsToCsv(products = []) {
  const head = EXPORT_COLUMNS.join(",");
  const rows = products.map((p) => [
    p.id,
    p.sku || "",
    p.name || "",
    p.status || "",
    p.regularPrice || "",
    p.salePrice || "",
    p.stockMode || "unlimited",
    p.stockQty == null ? "" : p.stockQty,
    p.hsn || "",
    p.codDisabled ? "off" : "on",
    (p.categories || []).map((c) => c.name).join(" | "),
    (p.brands || []).map((b) => b.name).join(" | "),
    p.shortDescription || "",
    p.description || "",
    (p.images || []).map((i) => i.src).join(" | "),
  ].map(csvCell).join(","));
  return [head, ...rows].join("\r\n");
}

/**
 * Splits CSV text into rows of cells.
 *
 * Written out rather than pulled from a library because the bridge takes no
 * new dependencies, and because the cases that matter are few: quoted fields,
 * doubled quotes inside them, commas and newlines inside quotes, and the three
 * line endings a spreadsheet might produce.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const s = String(text || "").replace(/^﻿/, "");   // Excel's byte-order mark

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(cell); cell = ""; continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && s[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  // A trailing newline leaves one empty row; nobody meant to import it.
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

/**
 * Reads a price out of whatever a spreadsheet put in the cell.
 *
 * Returns null rather than a number when there isn't one, which matters more
 * than it sounds: stripping non-digits from "abc" leaves "", and Number("")
 * is 0, so a nonsense cell would have silently set a product's price to zero.
 * Pulling the numeric token out instead means "Rs. 1,250.00" reads as 1250
 * while "abc" reads as nothing at all.
 */
export function parseMoney(raw) {
  const m = String(raw ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

const BOOL_OFF = new Set(["off", "no", "false", "0", "disabled"]);
const BOOL_ON = new Set(["on", "yes", "true", "1", "enabled"]);

function splitList(value) {
  return String(value || "").split("|").map((v) => v.trim()).filter(Boolean);
}

/**
 * Turns parsed CSV into product changes.
 *
 * Returns { rows, errors }. Each row carries only the fields its file actually
 * supplied, plus how it was matched, so the caller can show what will happen
 * before anything is written.
 */
export function csvToProducts(text) {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], errors: [{ line: 0, reason: "The file is empty." }] };

  const header = table[0].map((h) => String(h).trim().toLowerCase().replace(/\s+/g, "_"));
  const known = new Set(EXPORT_COLUMNS);
  const unknown = header.filter((h) => h && !known.has(h));
  const errors = [];
  if (unknown.length) {
    errors.push({ line: 1, reason: `Ignoring unrecognised columns: ${unknown.join(", ")}` });
  }
  if (!header.includes("id") && !header.includes("sku") && !header.includes("name")) {
    return { rows: [], errors: [{ line: 1, reason: "The file needs an id, sku or name column." }] };
  }

  const rows = [];
  for (let r = 1; r < table.length; r += 1) {
    const line = r + 1;
    const cells = table[r];
    const get = (col) => {
      const i = header.indexOf(col);
      return i === -1 || cells[i] === undefined ? undefined : String(cells[i]).trim();
    };

    const id = get("id");
    const sku = get("sku");
    const name = get("name");
    if (!id && !sku && !name) {
      errors.push({ line, reason: "No id, SKU or name on this row." });
      continue;
    }

    const change = {};
    const setIf = (col, key, convert = (v) => v) => {
      const v = get(col);
      if (v !== undefined && v !== "") change[key] = convert(v);
    };

    if (name !== undefined && name !== "") change.name = name;
    setIf("sku", "sku");
    setIf("status", "status", (v) => (v.toLowerCase() === "draft" ? "draft" : "publish"));
    setIf("short_description", "shortDescription");
    setIf("description", "description");
    setIf("hsn", "hsn");

    for (const [col, key] of [["mrp", "mrp"], ["price", "price"]]) {
      const raw = get(col);
      if (raw === undefined || raw === "") continue;
      const n = parseMoney(raw);
      if (n === null) errors.push({ line, reason: `"${raw}" is not a price.` });
      else if (n < 0) errors.push({ line, reason: `"${raw}" is a negative price.` });
      else change[key] = n;
    }

    const stock = get("stock");
    if (stock !== undefined && stock !== "") {
      const mode = stock.toLowerCase();
      if (!["unlimited", "tracked", "out"].includes(mode)) {
        errors.push({ line, reason: `"${stock}" is not unlimited, tracked or out.` });
      } else {
        change.stockMode = mode;
      }
    }
    const qty = get("quantity");
    if (qty !== undefined && qty !== "") {
      // Same trap as the price: Number("maybe") || 0 is 0, so a nonsense cell
      // would quietly set the stock to nothing and take the product off sale.
      const n = Number(String(qty).replace(/,/g, ""));
      if (!Number.isFinite(n)) errors.push({ line, reason: `"${qty}" is not a quantity.` });
      else change.stockQty = Math.max(0, Math.floor(n));
    }

    const cod = get("cod");
    if (cod !== undefined && cod !== "") {
      const v = cod.toLowerCase();
      if (BOOL_OFF.has(v)) change.codDisabled = true;
      else if (BOOL_ON.has(v)) change.codDisabled = false;
      else errors.push({ line, reason: `"${cod}" is not on or off.` });
    }

    const images = get("images");
    if (images !== undefined && images !== "") {
      change.images = splitList(images).map((src) => ({ src }));
    }

    // Categories and brands arrive as names; they are resolved to ids by the
    // caller, which is the only place that knows what the shop has.
    const categories = get("categories");
    if (categories !== undefined && categories !== "") change.categoryNames = splitList(categories);
    const brands = get("brands");
    if (brands !== undefined && brands !== "") change.brandNames = splitList(brands);

    // A row whose every value was unusable carries no change. Counting it as
    // an update would send an empty write and report work that did not happen.
    if (!Object.keys(change).length) {
      errors.push({ line, reason: "Nothing on this row could be used." });
      continue;
    }

    rows.push({
      line,
      id: id ? Number(id) : null,
      sku: sku || null,
      change,
    });
  }

  return { rows, errors };
}

/**
 * Decides, without writing anything, what an import would do.
 *
 * Matching is by id first and SKU second, because an exported file carries
 * both and a hand-written one usually carries only the SKU.
 */
export function planImport(rows, existing = []) {
  const byId = new Map(existing.map((p) => [String(p.id), p]));
  const bySku = new Map(existing.filter((p) => p.sku).map((p) => [String(p.sku).toLowerCase(), p]));

  const updates = [];
  const creations = [];
  for (const row of rows) {
    const match =
      (row.id != null && byId.get(String(row.id)))
      || (row.sku && bySku.get(String(row.sku).toLowerCase()))
      || null;
    if (match) updates.push({ ...row, productId: match.id, was: match });
    else creations.push(row);
  }
  return { updates, creations };
}

export function defaultHsnFor(change) {
  return change.hsn || DEFAULT_HSN;
}
