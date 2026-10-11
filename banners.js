// Homepage banners, held here rather than in the code.
//
// They used to be a hardcoded list in BannerCarousel.jsx pointing at files in
// public/banners/, so changing one meant an edit, a rebuild and a deploy. They
// live here now so the dashboard can change them and the storefront picks it
// up on the next load.
//
// Not a WordPress option: that would put a ~0.7s WordPress call in front of
// every homepage. A small JSON file read from memory costs nothing.

import fs from "fs";
import path from "path";
import os from "os";

const DIR = process.env.STORE_DIR || path.join(os.tmpdir(), "sba-store");
const FILE = path.join(DIR, "banners.json");

// What shipped in the code, used until someone saves a different set. The
// storefront is never bannerless because this file is missing.
const FALLBACK = [
  { id: "b1", src: "/banners/2x-guarantee.jpg", alt: "Found It Cheaper? We Pay You 2X — SB Ayurveda Lowest Price Guarantee", to: "/policy/2x-guarantee", active: true },
  { id: "b2", src: "/banners/hot-deals.jpg", alt: "Today's Hot Deals — Up to 55% Off, Genuine Ayurvedic Products", to: "/offers", active: true },
  { id: "b3", src: "/banners/free-shipping-cod.jpg", alt: "Free Shipping and Cash on Delivery — Same Day Dispatch, Pan-India Delivery", to: "/offers", active: true },
];

let cache = null;

export function listBanners() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = Array.isArray(parsed.banners) ? parsed.banners : FALLBACK;
  } catch {
    cache = FALLBACK;
  }
  return cache;
}

export function activeBanners() {
  return listBanners().filter((b) => b.active !== false);
}

function clean(b, i) {
  return {
    id: String(b.id || `b${Date.now()}${i}`).slice(0, 40),
    src: String(b.src || "").slice(0, 500),
    alt: String(b.alt || "").slice(0, 300),
    to: String(b.to || "/").slice(0, 200),
    active: b.active !== false,
  };
}

/**
 * Replaces the whole set — order in the array is order on the page.
 *
 * A save that would leave the homepage with no banner at all is refused: an
 * empty carousel looks like a broken site, and recovering from it needs a
 * developer, which is the thing this whole feature removes.
 */
export function saveBanners(banners) {
  if (!Array.isArray(banners)) {
    throw Object.assign(new Error("Banners must be a list."), { status: 400 });
  }
  const rows = banners.slice(0, 12).map(clean).filter((b) => b.src);
  if (!rows.some((b) => b.active)) {
    throw Object.assign(
      new Error("Keep at least one banner switched on — the homepage can't be left blank."),
      { status: 400 },
    );
  }
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ banners: rows, savedAt: Date.now() }), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  cache = rows;
  return rows;
}

export function _reset() {
  cache = null;
}
