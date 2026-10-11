// The storefront silently drops any product without a price, an image and a
// description — that is why 215 products are invisible today. Saving a product
// from the dashboard that the shop then refuses to show, with nothing said, is
// the failure these guard against.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { missingForStorefront, mediaFilename } from "../products.js";

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
