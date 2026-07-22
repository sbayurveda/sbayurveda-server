// Server-side mirror of the frontend's src/data/coupons.js. This copy is the
// authoritative one for money calculations — the frontend copy is only used
// for showing estimates before checkout. Keep them in sync manually if coupons
// change.
const COUPONS = {
  FIRST10: { type: "percent", value: 10, minOrder: 299, label: "10% off on your first order" },
  AYUR2X: { type: "flat", value: 100, minOrder: 799, label: "Flat ₹100 off above ₹799" },
  FREESHIP: { type: "shipping", value: 0, minOrder: 0, label: "Free shipping on any order" },
};

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
