// Server-side mirror of the frontend's src/data/coupons.js. This copy is the
// authoritative one for money calculations — the frontend copy is only used
// for showing estimates before checkout. Keep them in sync manually if coupons
// change.
//
// No coupons are currently active (disabled site-wide by request). Re-add
// entries to COUPONS to bring a code back.
const COUPONS = {};

export function validateCoupon(code, subtotal) {
  const c = COUPONS[code?.toUpperCase()];
  if (!c) return { valid: false, discount: 0, message: "Invalid coupon code" };
  if (subtotal < c.minOrder) {
    return { valid: false, discount: 0, message: `Order must be at least ₹${c.minOrder}` };
  }
  let discount = 0;
  if (c.type === "percent") discount = Math.round((subtotal * c.value) / 100);
  if (c.type === "flat") discount = c.value;
  return { valid: true, discount, code: code.toUpperCase(), label: c.label };
}
