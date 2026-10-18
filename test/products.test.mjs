// The storefront silently drops any product without a price, an image and a
// description — that is why 215 products are invisible today. Saving a product
// from the dashboard that the shop then refuses to show, with nothing said, is
// the failure these guard against.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { missingForStorefront, mediaFilename, sniffImage } from "../products.js";

// A 1x1 PNG — real bytes, so sniffing has something genuine to read.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("what stops a product being sellable", () => {
  const ok = {
    regular_price: "500",
    images: [{ id: 1, src: "https://example.com/a.jpg" }],
    description: "<p>A real description.</p>",
  };

  test("a complete product is clear", () => {
    assert.deepEqual(missingForStorefront(ok), []);
  });

  test("no image is reported — the shop hides these outright", () => {
    assert.deepEqual(missingForStorefront({ ...ok, images: [] }), ["image"]);
  });

  test("no price is reported", () => {
    assert.deepEqual(missingForStorefront({ ...ok, regular_price: "", price: "" }), ["price"]);
  });

  test("a sale price alone still counts as priced", () => {
    assert.deepEqual(missingForStorefront({ ...ok, regular_price: "", price: "450" }), []);
  });

  test("no description is reported", () => {
    assert.deepEqual(missingForStorefront({ ...ok, description: "", short_description: "" }), ["description"]);
  });

  test("a short description alone is enough", () => {
    assert.deepEqual(missingForStorefront({ ...ok, description: "", short_description: "Short but real." }), []);
  });

  test("whitespace is not a description", () => {
    assert.deepEqual(missingForStorefront({ ...ok, description: "   ", short_description: "\n\t " }), ["description"]);
  });

  test("everything missing is listed at once, not one at a time", () => {
    assert.deepEqual(
      missingForStorefront({ regular_price: "", images: [], description: "" }),
      ["price", "image", "description"],
    );
  });
});

describe("image filenames", () => {
  test("named after the product, so the media library stays searchable", () => {
    assert.equal(mediaFilename("Ashwagandha Churna (100g)", "IMG_4821.JPG"), "ashwagandha-churna-100g.jpg");
  });

  test("jpeg is normalised to jpg", () => {
    assert.equal(mediaFilename("Test", "photo.jpeg"), "test.jpg");
  });

  test("the real extension is kept", () => {
    assert.equal(mediaFilename("Test", "shot.png"), "test.png");
    assert.equal(mediaFilename("Test", "shot.webp"), "test.webp");
  });

  test("an unknown extension falls back to jpg rather than guessing", () => {
    assert.equal(mediaFilename("Test", "scan.tiff"), "test.jpg");
  });

  test("a name of only punctuation still produces a usable filename", () => {
    assert.equal(mediaFilename("!!!", "a.png"), "product.png");
    assert.equal(mediaFilename("", "a.png"), "product.png");
  });

  test("long names are cut, not rejected", () => {
    const out = mediaFilename("x".repeat(200), "a.jpg");
    assert.ok(out.length <= 64, out);
    assert.ok(out.endsWith(".jpg"));
  });
});

describe("staging an image for WooCommerce to collect", () => {
  test("a filename cannot escape the media directory", async () => {
    const { mediaPathFor, MEDIA_DIR } = await import("../products.js");
    for (const evil of ["../../etc/passwd", "..%2F..%2Fsecret", "/etc/passwd", ".."]) {
      const p = mediaPathFor(evil);
      assert.ok(p === null || p.startsWith(MEDIA_DIR), `${evil} escaped to ${p}`);
    }
  });

  test("a normal id resolves inside the media directory", async () => {
    const { mediaPathFor, MEDIA_DIR } = await import("../products.js");
    assert.ok(mediaPathFor("abc123-ashwagandha.jpg").startsWith(MEDIA_DIR));
  });

  test("upload needs no WordPress credential", async () => {
    // The whole point: WooCommerce collects the file itself with the consumer
    // key we already hold, so nothing here depends on a wp-admin login.
    const { mediaUploadConfigured } = await import("../products.js");
    assert.equal(mediaUploadConfigured(), true);
  });

  test("a file that is not an image is refused", async () => {
    const { uploadProductImage } = await import("../products.js");
    await assert.rejects(
      uploadProductImage({ base64: "AAAA", contentType: "application/pdf", filename: "x.pdf" }),
      /must be JPG/,
    );
  });

  test("an empty upload is refused rather than staged", async () => {
    const { uploadProductImage } = await import("../products.js");
    await assert.rejects(
      uploadProductImage({ base64: "", contentType: "image/png", filename: "x.png" }),
      /empty/,
    );
  });

  test("a staged file gets a public URL WooCommerce can fetch", async () => {
    const { uploadProductImage } = await import("../products.js");
    // 1x1 PNG
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const out = await uploadProductImage({
      base64: png, contentType: "image/png", filename: "IMG_1.PNG", productName: "Ashwagandha Churna (100g)",
    });
    assert.match(out.src, /^https?:\/\/.+\/media\/.+ashwagandha-churna-100g\.png$/);
    assert.ok(out.bytes > 0);
  });
});

// Real file headers. A test built from the same constant the code reads would
// only prove the constant equals itself.
const HEADERS = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  png: Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n", "latin1"), Buffer.from("\x00\x00\x00\x0d", "latin1")]),
  gif: Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00", "latin1"),
  webp: Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from("WEBPVP8 ", "latin1")]),
  avif: Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypavif", "latin1"), Buffer.from("avifmif1", "latin1")]),
  heic: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "latin1"), Buffer.from("heicmif1", "latin1")]),
  heix: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheix", "latin1"), Buffer.from("heixmif1", "latin1")]),
};

describe("identifying an image from its own bytes", () => {
  test("each publishable format is recognised with the right extension", () => {
    assert.deepEqual(sniffImage(HEADERS.jpeg), { type: "image/jpeg", ext: "jpg" });
    assert.deepEqual(sniffImage(HEADERS.png), { type: "image/png", ext: "png" });
    assert.deepEqual(sniffImage(HEADERS.gif), { type: "image/gif", ext: "gif" });
    assert.deepEqual(sniffImage(HEADERS.webp), { type: "image/webp", ext: "webp" });
    assert.deepEqual(sniffImage(HEADERS.avif), { type: "image/avif", ext: "avif" });
  });

  test("HEIC is told apart from AVIF, which shares its container", () => {
    // Both are ISO base media files; only the brand differs, and WordPress
    // publishes one and not the other.
    assert.deepEqual(sniffImage(HEADERS.heic), { heic: true });
    assert.deepEqual(sniffImage(HEADERS.heix), { heic: true });
    assert.equal(sniffImage(HEADERS.avif).ext, "avif");
  });

  test("anything else is not an image", () => {
    assert.equal(sniffImage(Buffer.from("%PDF-1.7 something", "latin1")), null);
    assert.equal(sniffImage(Buffer.from("<html><body>hello</body>", "latin1")), null);
    assert.equal(sniffImage(Buffer.alloc(0)), null);
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8])), null);  // truncated
  });
});

describe("the content type the browser claims is not trusted", () => {
  const stage = async (args) => {
    const { uploadProductImage } = await import("../products.js");
    return uploadProductImage(args);
  };

  test("a real PNG is staged even when the browser sent no content type", async () => {
    // Finder drag-and-drop does this, and the old exact-match check refused it.
    const out = await stage({
      base64: PNG_1PX, filename: "photo.png", contentType: "", productName: "Triphala",
    });
    assert.ok(out.src.endsWith("triphala.png"), out.src);
  });

  test("a content type with a parameter is not a reason to refuse", async () => {
    const out = await stage({
      base64: PNG_1PX, filename: "photo.png", contentType: "image/png;charset=binary", productName: "Triphala",
    });
    assert.ok(out.src.endsWith("triphala.png"), out.src);
  });

  test("the extension follows the bytes, not the filename", async () => {
    // WordPress refuses an upload whose extension disagrees with its contents,
    // so a PNG named .jpg must be staged as .png.
    const out = await stage({
      base64: PNG_1PX, filename: "mislabelled.jpg", contentType: "image/jpeg", productName: "Triphala",
    });
    assert.ok(out.src.endsWith("triphala.png"), out.src);
  });

  test("a file claiming to be an image but isn't is still refused", async () => {
    await assert.rejects(
      stage({ base64: Buffer.from("%PDF-1.7 not a picture at all").toString("base64"), filename: "x.jpg", contentType: "image/jpeg" }),
      /must be JPG/,
    );
  });

  test("an iPhone HEIC photo is refused by name, with the remedy", async () => {
    await assert.rejects(
      stage({ base64: HEADERS.heic.toString("base64"), filename: "IMG_4821.HEIC", contentType: "image/heic" }),
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /HEIC/);
        assert.match(err.message, /JPEG|Most Compatible/);
        return true;
      },
    );
  });
});

describe("what an update is allowed to change", () => {
  // The dashboard form sends every field, so these never bit in the UI. Any
  // partial update would have republished drafts and blanked names.
  test("an update touches only the fields it was given", async () => {
    const { toWooPayload } = await import("../products.js");
    const patch = toWooPayload({ images: [{ src: "https://x/y.jpg" }] });
    assert.deepEqual(Object.keys(patch), ["images"]);
  });

  test("an update never silently publishes a draft", async () => {
    const { toWooPayload } = await import("../products.js");
    assert.equal("status" in toWooPayload({ images: [] }), false);
    assert.equal(toWooPayload({ status: "draft" }).status, "draft");
    assert.equal(toWooPayload({ status: "publish" }).status, "publish");
  });

  test("an update never blanks the name", async () => {
    const { toWooPayload } = await import("../products.js");
    assert.equal("name" in toWooPayload({ price: 100 }), false);
    assert.equal(toWooPayload({ name: "  Triphala  " }).name, "Triphala");
  });

  test("an update never puts a sold-out product back on sale", async () => {
    const { toWooPayload } = await import("../products.js");
    assert.equal("stock_status" in toWooPayload({ price: 100 }), false);
    assert.equal(toWooPayload({ inStock: false }).stock_status, "outofstock");
    assert.equal("manage_stock" in toWooPayload({ price: 100 }), false);
  });

  test("an update never flattens a variable product to simple", async () => {
    const { toWooPayload } = await import("../products.js");
    assert.equal("type" in toWooPayload({ price: 100 }), false);
  });

  test("a new product still gets the defaults it needs", async () => {
    const { toWooPayload } = await import("../products.js");
    const made = toWooPayload({ name: "Triphala", mrp: 300 }, { creating: true });
    assert.equal(made.type, "simple");
    assert.equal(made.status, "publish");
    assert.equal(made.stock_status, "instock");
    assert.equal(made.manage_stock, false);
    assert.equal(made.name, "Triphala");
  });

  test("a new product can still be created as a draft", async () => {
    const { toWooPayload } = await import("../products.js");
    assert.equal(toWooPayload({ name: "X", status: "draft" }, { creating: true }).status, "draft");
  });
});

describe("sending images to WooCommerce", () => {
  // The live failure: "images[0][id] is not of type integer". A staged upload
  // is identified by a filename, and calling that field `id` made every caller
  // send it where an attachment id belongs.
  test("a staged image is sent as a src, never as an id", async () => {
    const { toWooPayload } = await import("../products.js");
    const staged = { stagedAs: "mvaxe17k-eae6a4f8-photo.png", src: "https://api.example/media/x.png" };
    assert.deepEqual(toWooPayload({ images: [staged] }).images, [{ src: "https://api.example/media/x.png" }]);
  });

  test("an image still carrying a non-numeric id falls back to its src", async () => {
    // Covers a browser holding the old shape from before this fix.
    const { toWooPayload } = await import("../products.js");
    const stale = { id: "mvaxe17k-eae6a4f8-photo.png", src: "https://api.example/media/x.png" };
    assert.deepEqual(toWooPayload({ images: [stale] }).images, [{ src: "https://api.example/media/x.png" }]);
  });

  test("an existing library image is still referenced by its attachment id", async () => {
    const { toWooPayload } = await import("../products.js");
    assert.deepEqual(
      toWooPayload({ images: [{ id: 8412, src: "https://old.example/wp-content/a.jpg" }] }).images,
      [{ id: 8412 }],
    );
    assert.deepEqual(toWooPayload({ images: [{ id: "8412" }] }).images, [{ id: 8412 }]);
  });

  test("no image is ever sent as a null id", async () => {
    const { toWooPayload } = await import("../products.js");
    for (const bad of [{ id: "abc", src: "u" }, { id: NaN, src: "u" }, { id: 0, src: "u" }, { id: -3, src: "u" }, { id: 1.5, src: "u" }]) {
      const out = toWooPayload({ images: [bad] }).images[0];
      assert.ok(!("id" in out) || Number.isInteger(out.id), JSON.stringify(out));
      assert.equal(JSON.stringify(out).includes("null"), false, JSON.stringify(out));
    }
  });

  test("staging does not hand back anything called an id", async () => {
    const { uploadProductImage } = await import("../products.js");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const out = await uploadProductImage({ base64: png, filename: "a.png", productName: "Triphala" });
    assert.equal("id" in out, false, "staging must not return a field named id");
    assert.ok(out.stagedAs && out.src.endsWith(".png"));
  });
});

describe("stamping HSN codes across the catalogue", () => {
  test("a code must look like an HSN code", async () => {
    const { setHsnForProducts } = await import("../products.js");
    for (const bad of ["", "abc", "12", "123456789", "30 04", null]) {
      await assert.rejects(setHsnForProducts([1], bad), /four to eight digits/, String(bad));
    }
  });

  test("nothing to change is not an error", async () => {
    const { setHsnForProducts } = await import("../products.js");
    assert.deepEqual(await setHsnForProducts([], "3004"), { updated: 0, products: [] });
  });

  test("a change that large is refused rather than attempted", async () => {
    const { setHsnForProducts } = await import("../products.js");
    await assert.rejects(
      setHsnForProducts(Array.from({ length: 2001 }, (_, i) => i + 1), "3004"),
      /more products than one change should touch/,
    );
  });
});

describe("how a product is stocked", () => {
  test("the three states are read back from WooCommerce's two fields", async () => {
    const { stockModeOf } = await import("../products.js");
    assert.equal(stockModeOf({ manage_stock: false, stock_status: "instock" }), "unlimited");
    assert.equal(stockModeOf({ manage_stock: true, stock_status: "instock" }), "tracked");
    assert.equal(stockModeOf({ manage_stock: false, stock_status: "outofstock" }), "out");
    // Out of stock wins over tracking: it is the fact that matters to a buyer.
    assert.equal(stockModeOf({ manage_stock: true, stock_status: "outofstock" }), "out");
  });

  test("a tracked product at zero is also out of stock", async () => {
    // The two fields must not be able to disagree, or the shop offers
    // something it cannot send.
    const { stockFieldsFor } = await import("../products.js");
    assert.deepEqual(stockFieldsFor("tracked", 0),
      { manage_stock: true, stock_quantity: 0, stock_status: "outofstock" });
    assert.deepEqual(stockFieldsFor("tracked", 7),
      { manage_stock: true, stock_quantity: 7, stock_status: "instock" });
  });

  test("a quantity is never negative or fractional", async () => {
    const { stockFieldsFor } = await import("../products.js");
    assert.equal(stockFieldsFor("tracked", -5).stock_quantity, 0);
    assert.equal(stockFieldsFor("tracked", 3.7).stock_quantity, 3);
    assert.equal(stockFieldsFor("tracked", "abc").stock_quantity, 0);
  });

  test("unlimited stops counting rather than setting a big number", async () => {
    const { stockFieldsFor } = await import("../products.js");
    assert.deepEqual(stockFieldsFor("unlimited"), { manage_stock: false, stock_status: "instock" });
  });

  test("a stock mode sets all three fields together in the payload", async () => {
    const { toWooPayload } = await import("../products.js");
    const out = toWooPayload({ stockMode: "tracked", stockQty: 12 });
    assert.equal(out.manage_stock, true);
    assert.equal(out.stock_quantity, 12);
    assert.equal(out.stock_status, "instock");
  });

  test("an update with no stock instruction still leaves stock alone", async () => {
    const { toWooPayload } = await import("../products.js");
    const out = toWooPayload({ price: 100 });
    for (const k of ["manage_stock", "stock_quantity", "stock_status"]) {
      assert.equal(k in out, false, `${k} should not be sent`);
    }
  });

  test("an unknown mode is refused rather than guessed", async () => {
    const { setStockForProducts } = await import("../products.js");
    await assert.rejects(setStockForProducts([1], "plenty"), /unlimited, tracked or out/);
  });
});

describe("creating products from a spreadsheet", () => {
  // Captures the batch body instead of sending it, so the payload can be
  // asserted rather than inferred from what a stub happened to store.
  async function captureBatch(args) {
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      sent.push(body);
      return {
        ok: true,
        json: async () => ({
          update: (body.update || []).map((u) => ({ ...u, meta_data: [], images: [] })),
          create: (body.create || []).map((c, i) => ({ id: 900 + i, ...c, meta_data: [], images: [] })),
        }),
      };
    };
    try {
      const { applyImport } = await import(`../products.js?p=${Math.random()}`);
      await applyImport(args);
    } finally {
      globalThis.fetch = realFetch;
    }
    return sent[0] ?? {};
  }

  test("a price with no MRP becomes the new product's regular price", async () => {
    // Otherwise WooCommerce has a sale price discounting nothing, shows no
    // price, and the storefront hides the product the import just created.
    const body = await captureBatch({ creations: [{ line: 2, change: { name: "Tonic", price: 349 } }] });
    assert.equal(body.create[0].regular_price, "349");
    assert.equal("sale_price" in body.create[0], false);
  });

  test("an explicit MRP and price are both kept", async () => {
    const body = await captureBatch({
      creations: [{ line: 2, change: { name: "Tonic", mrp: 500, price: 349 } }],
    });
    assert.equal(body.create[0].regular_price, "500");
    assert.equal(body.create[0].sale_price, "349");
  });

  test("an update is left alone — a sale price there is a real discount", async () => {
    const body = await captureBatch({
      updates: [{ line: 2, productId: 5001, change: { price: 349 } }],
    });
    assert.equal(body.update[0].sale_price, "349");
    assert.equal("regular_price" in body.update[0], false);
  });

  test("category and brand names are resolved to ids, unknown ones dropped", async () => {
    const body = await captureBatch({
      creations: [{ line: 2, change: { name: "Tonic", categoryNames: ["Immunity", "Nonsense"] } }],
      taxonomyIds: { categories: { immunity: 11 }, brands: {} },
    });
    assert.deepEqual(body.create[0].categories, [{ id: 11 }]);
  });
});

describe("names WordPress hands back HTML-encoded", () => {
  test("an ampersand reads as an ampersand", async () => {
    // "Cold &amp; Cough" shown on an editable page would be saved back with
    // the ampersand encoded a second time.
    const { decodeEntities } = await import("../products.js");
    assert.equal(decodeEntities("Cold &amp; Cough"), "Cold & Cough");
    assert.equal(decodeEntities("Mother&#039;s Care"), "Mother's Care");
    assert.equal(decodeEntities("&quot;Pure&quot;"), '"Pure"');
  });

  test("a numeric entity is decoded by its code point", async () => {
    const { decodeEntities } = await import("../products.js");
    assert.equal(decodeEntities("Ayurveda &#8211; Classic"), "Ayurveda – Classic");
    assert.equal(decodeEntities("&#2309;"), "अ");
  });

  test("ordinary text is left exactly as it is", async () => {
    const { decodeEntities } = await import("../products.js");
    assert.equal(decodeEntities("Ashwagandha Churna 100g"), "Ashwagandha Churna 100g");
    assert.equal(decodeEntities(""), "");
    assert.equal(decodeEntities(null), "");
  });

  test("something that only looks like an entity is untouched", async () => {
    const { decodeEntities } = await import("../products.js");
    assert.equal(decodeEntities("A & B"), "A & B");
    assert.equal(decodeEntities("50% off &notanentity;"), "50% off &notanentity;");
  });
});
