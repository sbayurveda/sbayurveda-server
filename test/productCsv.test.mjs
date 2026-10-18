import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { productsToCsv, parseCsv, csvToProducts, planImport, EXPORT_COLUMNS } from "../productCsv.js";

const product = (over = {}) => ({
  id: 5001, sku: "SBA-1", name: "Ashwagandha Churna 100g", status: "publish",
  regularPrice: 900, salePrice: 715, stockMode: "tracked", stockQty: 12,
  hsn: "3004", codDisabled: false,
  categories: [{ id: 1, name: "Immunity" }], brands: [{ id: 2, name: "SB" }],
  shortDescription: "Short", description: "Long", images: [{ src: "https://x/a.jpg" }],
  ...over,
});

describe("writing the catalogue out", () => {
  test("the header is the documented column list", () => {
    assert.equal(productsToCsv([]).split("\r\n")[0], EXPORT_COLUMNS.join(","));
  });

  test("a product round-trips back to the same values", () => {
    const csv = productsToCsv([product()]);
    const { rows, errors } = csvToProducts(csv);
    assert.deepEqual(errors, []);
    assert.equal(rows.length, 1);
    const c = rows[0].change;
    assert.equal(rows[0].id, 5001);
    assert.equal(c.name, "Ashwagandha Churna 100g");
    assert.equal(c.mrp, 900);
    assert.equal(c.price, 715);
    assert.equal(c.stockMode, "tracked");
    assert.equal(c.stockQty, 12);
    assert.equal(c.hsn, "3004");
    assert.equal(c.codDisabled, false);
    assert.deepEqual(c.categoryNames, ["Immunity"]);
  });

  test("a name containing a comma or quote survives the trip", () => {
    const csv = productsToCsv([product({ name: 'Ashwagandha, "premium" 100g' })]);
    assert.equal(csvToProducts(csv).rows[0].change.name, 'Ashwagandha, "premium" 100g');
  });

  test("a description containing newlines survives the trip", () => {
    const csv = productsToCsv([product({ description: "Line one\nLine two" })]);
    assert.equal(csvToProducts(csv).rows[0].change.description, "Line one\nLine two");
  });
});

describe("reading a spreadsheet in", () => {
  test("every line ending a spreadsheet might produce is handled", () => {
    for (const nl of ["\n", "\r\n", "\r"]) {
      const rows = parseCsv(`a,b${nl}1,2${nl}3,4${nl}`);
      assert.deepEqual(rows, [["a", "b"], ["1", "2"], ["3", "4"]], JSON.stringify(nl));
    }
  });

  test("Excel's byte-order mark does not become part of the first column", () => {
    const { rows } = csvToProducts("﻿id,price\r\n5001,500\r\n");
    assert.equal(rows[0].id, 5001);
    assert.equal(rows[0].change.price, 500);
  });

  test("a column the file does not have is not a change", () => {
    // The dangerous case: a file of just ids and prices must not blank every
    // name and description in the shop.
    const { rows } = csvToProducts("id,price\n5001,500\n");
    assert.deepEqual(Object.keys(rows[0].change), ["price"]);
  });

  test("an empty cell is not a change either", () => {
    const { rows } = csvToProducts("id,name,price\n5001,,500\n");
    assert.equal("name" in rows[0].change, false);
    assert.equal(rows[0].change.price, 500);
  });

  test("a bad value is reported with its line number, not guessed", () => {
    const { rows, errors } = csvToProducts("id,price,stock\n5001,abc,plenty\n5002,200,out\n");
    assert.ok(errors.some((e) => e.line === 2 && /not a price/.test(e.reason)));
    assert.ok(errors.some((e) => e.line === 2 && /unlimited, tracked or out/.test(e.reason)));
    // The good row still comes through.
    assert.ok(rows.some((r) => r.id === 5002 && r.change.stockMode === "out"));
  });

  test("a row with no id, SKU or name is skipped and reported", () => {
    const { rows, errors } = csvToProducts("id,sku,name,price\n,,,500\n5002,,,200\n");
    assert.equal(rows.length, 1);
    assert.ok(errors.some((e) => e.line === 2));
  });

  test("a file with none of the matching columns is refused outright", () => {
    const { rows, errors } = csvToProducts("price,stock\n500,out\n");
    assert.equal(rows.length, 0);
    assert.match(errors[0].reason, /needs an id, sku or name/);
  });

  test("unrecognised columns are reported but do not stop the import", () => {
    const { rows, errors } = csvToProducts("id,price,favourite_colour\n5001,500,blue\n");
    assert.equal(rows.length, 1);
    assert.ok(errors.some((e) => /unrecognised columns/i.test(e.reason)));
  });

  test("prices written with a currency symbol are still read", () => {
    const { rows } = csvToProducts("id,price\n5001,\"Rs. 1,250.00\"\n");
    assert.equal(rows[0].change.price, 1250);
  });

  test("cod accepts the words a person would actually type", () => {
    const { rows } = csvToProducts("id,cod\n1,off\n2,NO\n3,yes\n4,TRUE\n");
    assert.deepEqual(rows.map((r) => r.change.codDisabled), [true, true, false, false]);
  });

  test("a negative or fractional quantity is cleaned up", () => {
    const { rows } = csvToProducts("id,quantity\n1,-4\n2,3.9\n");
    assert.deepEqual(rows.map((r) => r.change.stockQty), [0, 3]);
  });
});

describe("deciding what an import will do before doing it", () => {
  const existing = [
    { id: 5001, sku: "SBA-1", name: "One" },
    { id: 5002, sku: "SBA-2", name: "Two" },
  ];

  test("an id matches an existing product", () => {
    const { updates, creations } = planImport([{ line: 2, id: 5001, sku: null, change: {} }], existing);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].productId, 5001);
    assert.equal(creations.length, 0);
  });

  test("a SKU matches when there is no id, whatever its case", () => {
    const { updates } = planImport([{ line: 2, id: null, sku: "sba-2", change: {} }], existing);
    assert.equal(updates[0].productId, 5002);
  });

  test("a row matching nothing is a new product", () => {
    const { updates, creations } = planImport([{ line: 2, id: null, sku: "NEW-1", change: {} }], existing);
    assert.equal(updates.length, 0);
    assert.equal(creations.length, 1);
  });

  test("the id wins over the SKU when they disagree", () => {
    const { updates } = planImport([{ line: 2, id: 5001, sku: "SBA-2", change: {} }], existing);
    assert.equal(updates[0].productId, 5001);
  });
});

describe("reading a price out of a cell", () => {
  test("a cell with no number in it is not a price of zero", async () => {
    // Stripping non-digits from "abc" leaves "", and Number("") is 0, so this
    // would have quietly set a product's price to nothing.
    const { parseMoney } = await import("../productCsv.js");
    assert.equal(parseMoney("abc"), null);
    assert.equal(parseMoney(""), null);
    assert.equal(parseMoney("-"), null);
    assert.equal(parseMoney(null), null);
  });

  test("the ways a person writes a rupee amount all read the same", async () => {
    const { parseMoney } = await import("../productCsv.js");
    for (const written of ["1250", "1,250", "1250.00", "Rs. 1,250.00", "₹1250", " 1250 "]) {
      assert.equal(parseMoney(written), 1250, written);
    }
  });

  test("a nonsense price is reported, and nothing is written", async () => {
    const { csvToProducts } = await import("../productCsv.js");
    const { rows, errors } = csvToProducts("id,price\n5001,abc\n");
    assert.ok(errors.some((e) => e.line === 2 && /not a price/.test(e.reason)));
    // With no usable value the row carries no change at all, so there is
    // nothing that could become a price of zero.
    assert.equal(rows.length, 0);
  });

  test("a bad price alongside a good value leaves the price alone", async () => {
    const { csvToProducts } = await import("../productCsv.js");
    const { rows, errors } = csvToProducts("id,price,quantity\n5001,abc,4\n");
    assert.ok(errors.some((e) => /not a price/.test(e.reason)));
    assert.equal("price" in rows[0].change, false, "a bad price must not become 0");
    assert.equal(rows[0].change.stockQty, 4);
  });

  test("a negative price is refused rather than applied", async () => {
    const { csvToProducts } = await import("../productCsv.js");
    const { rows, errors } = csvToProducts("id,price,quantity\n5001,-99,4\n");
    assert.ok(errors.some((e) => /negative price/.test(e.reason)));
    assert.equal("price" in rows[0].change, false);
  });
});

describe("rows that would change nothing", () => {
  test("a row whose values are all unusable is reported, not counted as work", async () => {
    const { csvToProducts } = await import("../productCsv.js");
    const { rows, errors } = csvToProducts("id,price,stock,cod\n5003,abc,plenty,maybe\n");
    assert.equal(rows.length, 0, "an empty change must not be reported as an update");
    assert.ok(errors.some((e) => e.line === 2 && /Nothing on this row/.test(e.reason)));
  });

  test("a row with one usable value among bad ones still counts", async () => {
    const { csvToProducts } = await import("../productCsv.js");
    const { rows } = csvToProducts("id,price,stock\n5003,500,plenty\n");
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0].change), ["price"]);
  });
});

describe("reading a quantity out of a cell", () => {
  test("a cell with no number is not a quantity of zero", async () => {
    // Number("maybe") || 0 is 0, which would set the stock to nothing and
    // take the product off sale.
    const { csvToProducts } = await import("../productCsv.js");
    const { rows, errors } = csvToProducts("id,quantity\n5001,maybe\n");
    assert.ok(errors.some((e) => e.line === 2 && /not a quantity/.test(e.reason)));
    assert.equal(rows.length, 0, "an unreadable quantity must not become 0");
  });

  test("a real quantity still reads, commas and all", async () => {
    const { csvToProducts } = await import("../productCsv.js");
    const { rows } = csvToProducts("id,quantity\n1,12\n2,\"1,200\"\n3,-4\n4,3.9\n");
    assert.deepEqual(rows.map((r) => r.change.stockQty), [12, 1200, 0, 3]);
  });

  test("zero is a real instruction and is kept", async () => {
    const { csvToProducts } = await import("../productCsv.js");
    const { rows } = csvToProducts("id,quantity\n5001,0\n");
    assert.equal(rows[0].change.stockQty, 0);
  });
});
