// Everything needed to create a WooCommerce order, parked on disk from the
// moment a payment is started.
//
// Why this exists: an order used to be created only when the customer's browser
// came back from Razorpay and called verify-payment. UPI breaks that. The phone
// jumps to GPay/PhonePe, the money is captured, and if the customer never
// returns — app closed, phone locked, tab killed by the OS — the call never
// arrives and there is no order, with no error anywhere because nothing ever
// reached the server. Four real customers lost orders this way in two days.
//
// With the details written here up front, Razorpay's server-to-server webhook
// can finish the order on its own. Disk rather than memory because the process
// restarts on every deploy, and a customer mid-payment must survive that.

import fs from "fs";
import path from "path";
import os from "os";

// Deploys replace the app directory, so this must point somewhere outside it.
const DIR = process.env.PENDING_ORDER_DIR || path.join(os.tmpdir(), "sba-pending-orders");
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function safeId(razorpayOrderId) {
  // These become filenames — never let anything path-ish through.
  return String(razorpayOrderId).replace(/[^A-Za-z0-9_-]/g, "");
}

function fileFor(razorpayOrderId) {
  return path.join(DIR, `${safeId(razorpayOrderId)}.json`);
}

function write(razorpayOrderId, record) {
  fs.mkdirSync(DIR, { recursive: true });
  const target = fileFor(razorpayOrderId);
  // Write-then-rename so a crash mid-write can't leave a half-parsed file
  // that would strand a paid customer.
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function readRecord(razorpayOrderId) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(razorpayOrderId), "utf8"));
  } catch {
    return null;
  }
}

// Called when the payment is created, before the customer leaves for their
// UPI app.
export function savePending(razorpayOrderId, { quote, customer, attribution }) {
  try {
    write(razorpayOrderId, {
      razorpayOrderId,
      quote,
      customer,
      attribution,
      createdAt: Date.now(),
      order: null,
    });
  } catch (err) {
    // Never block a payment because the disk misbehaved — verify-payment can
    // still complete the order the usual way.
    console.error("savePending failed:", err.message);
  }
}

// Called once an order exists, so a later webhook retry (or the browser
// arriving late) reuses it instead of creating a second one.
export function markCompleted(razorpayOrderId, order) {
  try {
    const existing = readRecord(razorpayOrderId) || { razorpayOrderId, createdAt: Date.now() };
    write(razorpayOrderId, { ...existing, order, completedAt: Date.now() });
  } catch (err) {
    console.error("markCompleted failed:", err.message);
  }
}

export function getCompletedOrder(razorpayOrderId) {
  return readRecord(razorpayOrderId)?.order || null;
}

export function cleanupOld() {
  try {
    if (!fs.existsSync(DIR)) return;
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const name of fs.readdirSync(DIR)) {
      const file = path.join(DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        // A file vanishing under us is fine.
      }
    }
  } catch (err) {
    console.error("pending cleanup failed:", err.message);
  }
}

export function pendingDir() {
  return DIR;
}
