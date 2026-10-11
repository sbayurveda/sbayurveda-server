// Customers, reconstructed from the order book.
//
// Checkout has no login and no customer_id is ever sent, so every order in
// WooCommerce is a guest order and its own Customers list is near-empty. The
// only durable identity across orders is the phone number: it is required at
// checkout, the courier uses it, and unlike the email field it is rarely junk.
//
// The figure worth the whole screen is the cancellation rate per number. COD
// cancels at 27.5% against 1.8% on prepaid, and that cost is not spread evenly
// — it concentrates on a few numbers that cancel again and again. Grouping by
// phone is what turns that from a statistic into a list you can act on.

const DEAD = ["cancelled", "refunded", "failed"];

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// The last ten digits. Customers enter the same number as 9876543210,
// +919876543210 and 09876543210; those are one person, not three.
export function phoneKey(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

function isCod(order) {
  return String(order.paymentMethod || "").toLowerCase() === "cod";
}

/**
 * Groups orders into customers.
 *
 * Orders with no usable phone number are counted in `unidentified` rather than
 * lumped together under a blank key, which would invent one enormous customer
 * out of everyone we could not identify.
 */
export function buildCustomers(orders = []) {
  const byPhone = new Map();
  let unidentified = 0;

  for (const order of orders) {
    const key = phoneKey(order.billing?.phone);
    if (!key) {
      unidentified += 1;
      continue;
    }

    let c = byPhone.get(key);
    if (!c) {
      c = {
        phone: key,
        name: "",
        email: "",
        city: "",
        state: "",
        orders: 0,
        placed: 0,
        cancelled: 0,
        lifetimeValue: 0,
        codOrders: 0,
        prepaidOrders: 0,
        firstOrderAt: null,
        lastOrderAt: null,
        orderIds: [],
      };
      byPhone.set(key, c);
    }

    const dead = DEAD.includes(order.status);
    const total = Number(order.total || 0);

    c.placed += 1;
    c.orderIds.push(order.id);
    if (dead) c.cancelled += 1;
    else {
      c.orders += 1;
      c.lifetimeValue += total;
    }
    if (isCod(order)) c.codOrders += 1;
    else c.prepaidOrders += 1;

    // Keep the most recent details: people move, and the latest address is
    // the one worth calling.
    const when = order.dateCreated || "";
    if (!c.lastOrderAt || when > c.lastOrderAt) {
      c.lastOrderAt = when;
      c.name = [order.billing?.first_name, order.billing?.last_name].filter(Boolean).join(" ").trim() || c.name;
      c.email = order.billing?.email || c.email;
      c.city = order.billing?.city || c.city;
      c.state = order.billing?.state || c.state;
    }
    if (!c.firstOrderAt || when < c.firstOrderAt) c.firstOrderAt = when;
  }

  const customers = [...byPhone.values()].map((c) => ({
    ...c,
    lifetimeValue: round2(c.lifetimeValue),
    averageOrder: c.orders ? round2(c.lifetimeValue / c.orders) : 0,
    cancelRate: c.placed ? Math.round((c.cancelled / c.placed) * 1000) / 10 : 0,
    pays: c.codOrders && c.prepaidOrders ? "mixed" : c.codOrders ? "cod" : "prepaid",
    repeat: c.orders > 1,
  }));

  customers.sort((a, b) => b.lifetimeValue - a.lifetimeValue);
  return { customers, unidentified };
}

/**
 * The numbers worth refusing cash on delivery to.
 *
 * Needs a minimum number of attempts before judging: one cancelled order out
 * of one is a bad day, not a pattern, and blocking on that loses a customer.
 */
export function codRisks(customers = [], { minOrders = 3, minRate = 40 } = {}) {
  return customers
    .filter((c) => c.codOrders > 0 && c.placed >= minOrders && c.cancelRate >= minRate)
    .sort((a, b) => b.cancelled - a.cancelled);
}

export function customerSummary(customers = []) {
  const repeat = customers.filter((c) => c.repeat);
  const value = customers.reduce((s, c) => s + c.lifetimeValue, 0);
  const repeatValue = repeat.reduce((s, c) => s + c.lifetimeValue, 0);
  return {
    total: customers.length,
    repeat: repeat.length,
    repeatShare: customers.length ? Math.round((repeat.length / customers.length) * 1000) / 10 : 0,
    averageLifetime: customers.length ? round2(value / customers.length) : 0,
    averageRepeatLifetime: repeat.length ? round2(repeatValue / repeat.length) : 0,
    atRisk: codRisks(customers).length,
  };
}
