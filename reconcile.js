// Works out which captured payments never became an order.
//
// Deliberately a pure function over two lists rather than something that talks
// to Razorpay and WooCommerce itself: this is the calculation that decides
// whether a customer's money is unaccounted for, so it needs to be testable
// without a network.

// A payment is only "safe" once its id appears on an order. Reconciliation has
// to start from the gateway's list, not ours — the failure being detected is
// precisely that our side has no record of the order.
export function findOrphanedPayments({ capturedPayments = [], bookedPaymentIds = new Set(), hasSavedCart = () => false }) {
  const orphans = [];

  for (const payment of capturedPayments) {
    if (!payment?.id) continue;
    if (bookedPaymentIds.has(payment.id)) continue;

    // Without the saved cart there's no way to know what was bought — the
    // gateway only records an amount — so those are reported for a human
    // rather than guessed at.
    const recoverable = hasSavedCart(payment.order_id);

    orphans.push({
      paymentId: payment.id,
      razorpayOrderId: payment.order_id,
      amount: (payment.amount ?? 0) / 100,
      email: payment.email || "",
      contact: payment.contact || "",
      method: payment.method || "",
      createdAt: payment.created_at ? new Date(payment.created_at * 1000).toISOString() : null,
      recoverable,
      reason: recoverable ? null : "no saved cart for this payment — create the order by hand",
    });
  }

  return orphans;
}

export function summariseReconciliation(capturedPayments, orphans) {
  const total = orphans.reduce((sum, o) => sum + o.amount, 0);
  return {
    capturedPayments: capturedPayments.length,
    alreadyBooked: capturedPayments.length - orphans.length,
    orphaned: orphans.length,
    orphanedValue: Math.round(total * 100) / 100,
  };
}
