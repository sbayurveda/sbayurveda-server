// Three independent reasons to withhold cash on delivery. Each has to work on
// its own, and the customer has to be told which one applied — a payment
// method that vanishes without explanation reads as a broken checkout.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

process.env.STORE_DIR = mkdtempSync(`${tmpdir()}/sba-cod-`);
const { codAvailability, saveCodRules, blockPhone, unblockPhone, isPhoneBlocked, phoneKey, _reset } =
  await import("../codRules.js");

const CART = [{ wcId: 101, name: "Churna" }, { wcId: 102, name: "Kamyog Avleh (1kg)" }];

beforeEach(() => {
  _reset();
  saveCodRules({ enabled: true, minOrderValue: 300, maxOrderValue: 2200, fee: 36, blockedPhones: [] });
});

describe("the value band", () => {
  const ask = (collectable) => codAvailability({ collectable, items: CART, phone: "9876543210" });

  test("inside the band it is offered", () => {
    assert.equal(ask(700).allowed, true);
    assert.equal(ask(300).allowed, true, "the floor itself is allowed");
    assert.equal(ask(2200).allowed, true, "the ceiling itself is allowed");
  });

  test("below the floor it is refused, by name", () => {
    const v = ask(299);
    assert.equal(v.allowed, false);
    assert.match(v.reason, /below ₹300/);
  });

  test("above the ceiling it is refused, by name", () => {
    const v = ask(2201);
    assert.equal(v.allowed, false);
    assert.match(v.reason, /above ₹2200/);
  });

  test("the limits are whatever was last saved, not what was compiled in", () => {
    saveCodRules({ minOrderValue: 500, maxOrderValue: 1000 });
    assert.equal(ask(700).allowed, true);
    assert.equal(ask(400).allowed, false);
    assert.equal(ask(1500).allowed, false);
  });

  test("a band with the floor above the ceiling is refused, not saved", () => {
    // It would offer COD to nobody while looking configured.
    assert.throws(() => saveCodRules({ minOrderValue: 3000, maxOrderValue: 500 }), /can't be above/);
  });
});

describe("a product with COD switched off", () => {
  const blocked = new Set([102]);

  test("one such product takes COD off the whole cart", () => {
    // An order cannot be part cash and part card.
    const v = codAvailability({ collectable: 700, items: CART, phone: "9876543210", blockedProductIds: blocked });
    assert.equal(v.allowed, false);
    assert.match(v.reason, /Kamyog Avleh/, "the customer is told which product");
  });

  test("a cart without it is unaffected", () => {
    const v = codAvailability({
      collectable: 700, items: [{ wcId: 101, name: "Churna" }], phone: "9876543210", blockedProductIds: blocked,
    });
    assert.equal(v.allowed, true);
  });

  test("the product rule beats the value rule, so the message is the useful one", () => {
    // Telling someone to spend less when the real problem is the item would
    // send them round in circles.
    const v = codAvailability({ collectable: 5000, items: CART, phone: "9876543210", blockedProductIds: blocked });
    assert.match(v.reason, /Kamyog Avleh/);
  });
});

describe("a blocked phone number", () => {
  test("the same number written any way is the same number", () => {
    blockPhone("+91 98765 43210", "4 of 6 refused");
    for (const form of ["9876543210", "+919876543210", "09876543210", "98765 43210"]) {
      assert.equal(isPhoneBlocked(form), true, form);
    }
  });

  test("a blocked number cannot pay on delivery, and is told nothing", () => {
    blockPhone("9876543210", "refused three times");
    const v = codAvailability({ collectable: 700, items: CART, phone: "09876543210" });
    assert.equal(v.allowed, false);
    assert.equal(v.silent, true, "the option just is not there — no explanation to the customer");
    assert.doesNotMatch(v.reason, /phone/i, "nothing may hint that the number was the reason");
  });

  test("the other two refusals still explain themselves", () => {
    // Only the phone block is silent. A customer who can act on the reason
    // should be given it.
    assert.equal(codAvailability({ collectable: 100, items: CART, phone: "9000000000" }).silent, false);
    assert.equal(
      codAvailability({ collectable: 700, items: CART, phone: "9000000000", blockedProductIds: new Set([102]) }).silent,
      false,
    );
  });

  test("blocking is reversible", () => {
    blockPhone("9876543210", "x");
    unblockPhone("9876543210");
    assert.equal(isPhoneBlocked("9876543210"), false);
    assert.equal(codAvailability({ collectable: 700, items: CART, phone: "9876543210" }).allowed, true);
  });

  test("blocking the same number twice does not duplicate it", () => {
    blockPhone("9876543210", "first");
    const rules = blockPhone("9876543210", "second");
    assert.equal(rules.blockedPhones.filter((b) => b.phone === "9876543210").length, 1);
  });

  test("a number too short to be real is refused", () => {
    assert.throws(() => blockPhone("12345"), /usable phone number/);
    assert.equal(phoneKey("12345"), "");
  });

  test("an unrecorded number is not blocked", () => {
    assert.equal(isPhoneBlocked("9000000000"), false);
    assert.equal(isPhoneBlocked(""), false);
    assert.equal(isPhoneBlocked(null), false);
  });
});

describe("switching it off everywhere", () => {
  test("nothing is offered COD, whatever else is true", () => {
    saveCodRules({ enabled: false });
    const v = codAvailability({ collectable: 700, items: CART, phone: "9876543210" });
    assert.equal(v.allowed, false);
    assert.match(v.reason, /isn't available at the moment/);
  });

  test("switching it back on restores the band", () => {
    saveCodRules({ enabled: false });
    saveCodRules({ enabled: true });
    assert.equal(codAvailability({ collectable: 700, items: CART, phone: "9876543210" }).allowed, true);
  });
});

describe("one reason at a time", () => {
  test("a customer is told what to do, not given an audit", () => {
    saveCodRules({ enabled: false });
    const v = codAvailability({ collectable: 99999, items: CART, phone: "9876543210", blockedProductIds: new Set([102]) });
    assert.equal(typeof v.reason, "string");
    assert.ok(!v.reason.includes("\n"), "one sentence, not a list of everything wrong");
  });
});
