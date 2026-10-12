// When cash on delivery is offered, and when it isn't.
//
// Three independent rules, any one of which withdraws it: the order value, the
// products in the cart, and the phone number. They were constants in the
// server until now, so changing the ₹300–₹2,200 band meant a deploy.
//
// Stored beside the banners, outside the app directory so a deploy cannot wipe
// them. A WordPress option would put a ~0.7s WordPress call in front of every
// checkout; a small JSON file read from memory costs nothing.

import fs from "fs";
import path from "path";
import os from "os";

const DIR = process.env.STORE_DIR || path.join(os.tmpdir(), "sba-store");
const FILE = path.join(DIR, "cod-rules.json");

// What the server has always enforced, used until someone saves something
// different. Env vars still win on first run, so an existing deployment keeps
// the band it was given.
const DEFAULTS = {
  enabled: true,
  minOrderValue: Number(process.env.COD_MIN_ORDER_VALUE || 300),
  maxOrderValue: Number(process.env.COD_MAX_ORDER_VALUE || 2200),
  fee: Number(process.env.COD_FEE || 36),
  blockedPhones: [],   // { phone, blockedAt, reason }
};

let cache = null;

export function phoneKey(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

export function codRules() {
  if (cache) return cache;
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = { ...DEFAULTS, ...saved, blockedPhones: saved.blockedPhones || [] };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function clampMoney(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1000000 ? Math.round(n * 100) / 100 : fallback;
}

export function saveCodRules(input = {}) {
  const current = codRules();
  const min = clampMoney(input.minOrderValue, current.minOrderValue);
  const max = clampMoney(input.maxOrderValue, current.maxOrderValue);

  // A band with the floor above the ceiling offers cash on delivery to nobody
  // while appearing to be configured. Say so rather than saving it.
  if (min > max) {
    throw Object.assign(
      new Error("The lower limit can't be above the upper one."),
      { status: 400 },
    );
  }

  const next = {
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : current.enabled,
    minOrderValue: min,
    maxOrderValue: max,
    fee: clampMoney(input.fee, current.fee),
    blockedPhones: Array.isArray(input.blockedPhones)
      ? input.blockedPhones
          .map((b) => ({
            phone: phoneKey(b.phone),
            blockedAt: b.blockedAt || new Date().toISOString(),
            reason: String(b.reason || "").slice(0, 200),
          }))
          .filter((b) => b.phone)
          .slice(0, 2000)
      : current.blockedPhones,
  };

  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  cache = next;
  return next;
}

export function blockPhone(phone, reason) {
  const key = phoneKey(phone);
  if (!key) throw Object.assign(new Error("That isn't a usable phone number."), { status: 400 });
  const rules = codRules();
  if (rules.blockedPhones.some((b) => b.phone === key)) return rules;
  return saveCodRules({
    ...rules,
    blockedPhones: [...rules.blockedPhones, { phone: key, blockedAt: new Date().toISOString(), reason }],
  });
}

export function unblockPhone(phone) {
  const key = phoneKey(phone);
  const rules = codRules();
  return saveCodRules({ ...rules, blockedPhones: rules.blockedPhones.filter((b) => b.phone !== key) });
}

export function isPhoneBlocked(phone) {
  const key = phoneKey(phone);
  return Boolean(key) && codRules().blockedPhones.some((b) => b.phone === key);
}

/**
 * Decides whether one cart may pay on delivery, and says why not.
 *
 * `collectable` is goods plus delivery — what the courier is actually asked to
 * hand over, before the handling fee is added on top.
 *
 * Returns the first reason found rather than all of them: a customer needs to
 * know what to do next, not an audit of everything wrong.
 */
export function codAvailability({ collectable, items = [], phone, blockedProductIds = new Set() }) {
  const rules = codRules();

  if (!rules.enabled) {
    return { allowed: false, silent: false, reason: "Cash on Delivery isn't available at the moment. Please pay online." };
  }

  const blocked = items.find((i) => blockedProductIds.has(Number(i.wcId ?? i.productId ?? i.id)));
  if (blocked) {
    const name = blocked.name ? ` for ${blocked.name}` : "";
    return { allowed: false, silent: false, reason: `Cash on Delivery isn't available${name}. Please pay online to place this order.` };
  }

  if (collectable > rules.maxOrderValue) {
    return {
      allowed: false,
      silent: false,
      reason: `Cash on Delivery isn't available above ₹${rules.maxOrderValue}. Please pay online to place this order.`,
    };
  }
  if (collectable < rules.minOrderValue) {
    return {
      allowed: false,
      silent: false,
      reason: `Cash on Delivery isn't available below ₹${rules.minOrderValue}. Please pay online to place this order.`,
    };
  }

  if (isPhoneBlocked(phone)) {
    return {
      allowed: false,
      // No explanation to the customer. Telling someone their number has been
      // refused invites an argument on the phone and tells them they have been
      // flagged; the option simply is not there, the way it is not there for
      // anyone in a region we do not serve. `silent` is what the checkout
      // reads — the reason below is only ever seen by a crafted request that
      // skipped the page.
      silent: true,
      reason: "Cash on Delivery isn't available for this order. Please pay online.",
    };
  }

  return { allowed: true, reason: null };
}

export function _reset() {
  cache = null;
}
