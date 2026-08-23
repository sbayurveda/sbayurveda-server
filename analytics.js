// Turns a list of orders into the numbers the dashboard's analytics panel shows.
//
// Kept as a pure function over an array so it can be reasoned about and tested
// without touching WooCommerce: the caller fetches, this counts.

// Money was never really earned on these, so they're excluded from revenue and
// from the order count. They're still counted separately for the cancellation
// rate, which is the whole point of tracking COD.
const DEAD_STATUSES = ["cancelled", "refunded", "failed"];

function isCod(order) {
  return String(order.paymentMethod || "").toLowerCase().includes("cod");
}

function isLive(order) {
  return !DEAD_STATUSES.includes(order.status);
}

function unitsOf(order) {
  return (order.lineItems || []).reduce((sum, i) => sum + Number(i.qty || 0), 0);
}

function summarise(orders) {
  const live = orders.filter(isLive);
  const revenue = live.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const units = live.reduce((sum, o) => sum + unitsOf(o), 0);
  return {
    revenue: Math.round(revenue * 100) / 100,
    orders: live.length,
    units,
    aov: live.length ? Math.round((revenue / live.length) * 100) / 100 : 0,
  };
}

// WooCommerce hands back store-local timestamps with no zone, so the date part
// is taken as-is rather than parsed — otherwise orders drift across midnight.
function dayOf(iso) {
  return String(iso || "").slice(0, 10);
}

function eachDay(fromDay, toDay) {
  const days = [];
  const cursor = new Date(`${fromDay}T00:00:00Z`);
  const end = new Date(`${toDay}T00:00:00Z`);
  while (cursor <= end && days.length < 400) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function topBy(map, key, limit = 10) {
  return [...map.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b[key] - a[key])
    .slice(0, limit);
}

export function computeAnalytics(orders, { from, to, previousFrom, previousTo }) {
  const inRange = (o) => dayOf(o.dateCreated) >= from && dayOf(o.dateCreated) <= to;
  const inPrevious = (o) =>
    dayOf(o.dateCreated) >= previousFrom && dayOf(o.dateCreated) <= previousTo;

  const current = orders.filter(inRange);
  const previous = orders.filter(inPrevious);

  // --- daily trend -----------------------------------------------------------
  const byDay = new Map(eachDay(from, to).map((d) => [d, { revenue: 0, orders: 0 }]));
  for (const order of current) {
    if (!isLive(order)) continue;
    const bucket = byDay.get(dayOf(order.dateCreated));
    if (!bucket) continue;
    bucket.revenue += Number(order.total || 0);
    bucket.orders += 1;
  }
  const trend = [...byDay.entries()].map(([date, v]) => ({
    date,
    revenue: Math.round(v.revenue * 100) / 100,
    orders: v.orders,
  }));

  // --- COD vs prepaid --------------------------------------------------------
  // Cancellation rate is measured over every order placed, not just the live
  // ones — a cancelled COD order is exactly what we're trying to see.
  function paymentSplit(list) {
    const placed = list.length;
    const cancelled = list.filter((o) => DEAD_STATUSES.includes(o.status)).length;
    const live = list.filter(isLive);
    return {
      orders: live.length,
      placed,
      cancelled,
      cancelRate: placed ? Math.round((cancelled / placed) * 1000) / 10 : 0,
      revenue: Math.round(live.reduce((s, o) => s + Number(o.total || 0), 0) * 100) / 100,
    };
  }
  const payment = {
    cod: paymentSplit(current.filter(isCod)),
    prepaid: paymentSplit(current.filter((o) => !isCod(o))),
  };

  // --- products --------------------------------------------------------------
  const products = new Map();
  for (const order of current) {
    if (!isLive(order)) continue;
    for (const item of order.lineItems || []) {
      const key = item.name || "(unnamed)";
      const entry = products.get(key) || { revenue: 0, units: 0 };
      entry.revenue += Number(item.total || 0);
      entry.units += Number(item.qty || 0);
      products.set(key, entry);
    }
  }
  for (const entry of products.values()) {
    entry.revenue = Math.round(entry.revenue * 100) / 100;
  }

  // --- geography -------------------------------------------------------------
  const states = new Map();
  const cities = new Map();
  for (const order of current) {
    if (!isLive(order)) continue;
    const s = order.shipping || {};
    const b = order.billing || {};
    const addTo = (map, rawKey) => {
      const key = String(rawKey || "").trim();
      if (!key) return;
      const entry = map.get(key) || { revenue: 0, orders: 0 };
      entry.revenue += Number(order.total || 0);
      entry.orders += 1;
      map.set(key, entry);
    };
    addTo(states, s.state || b.state);
    // Casing varies by who typed it, so city names are normalised for grouping.
    const city = (s.city || b.city || "").trim().toLowerCase();
    addTo(cities, city ? city.charAt(0).toUpperCase() + city.slice(1) : "");
  }
  for (const map of [states, cities]) {
    for (const entry of map.values()) entry.revenue = Math.round(entry.revenue * 100) / 100;
  }

  // --- traffic source --------------------------------------------------------
  // Only recorded from the day attribution shipped, so orders before that are
  // reported honestly as "not recorded" rather than lumped into "direct".
  const sources = new Map();
  for (const order of current) {
    if (!isLive(order)) continue;
    const key = order.sourceType || "not recorded";
    const entry = sources.get(key) || { revenue: 0, orders: 0 };
    entry.revenue += Number(order.total || 0);
    entry.orders += 1;
    sources.set(key, entry);
  }
  for (const entry of sources.values()) entry.revenue = Math.round(entry.revenue * 100) / 100;

  // --- fulfilment ------------------------------------------------------------
  const shipped = current.filter(
    (o) => (o.trackingCode || o.trackingUrl) && o.status !== "completed" && isLive(o)
  ).length;
  const delivered = current.filter((o) => o.status === "completed").length;
  const awaitingDispatch = current.filter(
    (o) => isLive(o) && o.status !== "completed" && !o.trackingCode && !o.trackingUrl
  ).length;

  const completedWithTimes = current.filter((o) => o.status === "completed" && o.dateCompleted);
  const avgHoursToComplete = completedWithTimes.length
    ? Math.round(
        (completedWithTimes.reduce(
          (sum, o) => sum + (new Date(o.dateCompleted) - new Date(o.dateCreated)) / 3600000,
          0
        ) /
          completedWithTimes.length) *
          10
      ) / 10
    : null;

  const codOutstanding =
    Math.round(
      current
        .filter((o) => isCod(o) && isLive(o) && !o.isPaid)
        .reduce((sum, o) => sum + Number(o.total || 0), 0) * 100
    ) / 100;

  return {
    range: { from, to, previousFrom, previousTo },
    totals: summarise(current),
    previous: summarise(previous),
    trend,
    payment,
    topProductsByRevenue: topBy(products, "revenue"),
    topProductsByUnits: topBy(products, "units"),
    states: topBy(states, "revenue"),
    cities: topBy(cities, "revenue"),
    sources: topBy(sources, "orders", 8),
    fulfilment: {
      awaitingDispatch,
      shipped,
      delivered,
      avgHoursToComplete,
      codOutstanding,
    },
  };
}
