"use strict";

const crypto = require("crypto");

const { config } = require("./config");
const store = require("./store");

/**
 * Receiving webhooks from Zarokaa.
 *
 * THE THREE THINGS THAT GO WRONG, and what this file does about each:
 *
 *  1. VERIFYING AGAINST A RE-SERIALISED BODY. This is the single most common
 *     webhook support ticket anywhere. `JSON.stringify(req.body)` is not the
 *     bytes Zarokaa signed — key order and whitespace differ — so the signature
 *     never matches and the developer concludes the platform is broken. The
 *     route below is mounted with `express.raw()` for exactly this reason, and
 *     `verify()` takes a Buffer, not an object.
 *
 *  2. ASSUMING EXACTLY-ONCE DELIVERY. It is at-least-once. The same `id` will
 *     arrive again after a retry whose 200 was lost, and again on a replay from
 *     the portal. Deduplicate on it.
 *
 *  3. DOING THE WORK BEFORE ANSWERING. Zarokaa times out at 10 seconds and
 *     retries. Acknowledge as soon as the event is durably accepted, then work.
 */

const TOLERANCE_SECONDS = 300;

/**
 * @param {Buffer|string} rawBody the bytes as received — NOT a parsed object
 * @param {string} header the X-Polygon-Signature value
 */
function verify(rawBody, header, secret = config.webhookSecret) {
  if (!secret) return { ok: false, reason: "no webhook secret is configured" };
  if (!header) return { ok: false, reason: "no signature header" };

  const parts = {};
  const provided = [];
  for (const piece of String(header).split(",")) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (key === "t") parts.t = value;
    else if (key === "v1") provided.push(value);
  }

  if (!parts.t || !/^\d+$/.test(parts.t)) return { ok: false, reason: "malformed timestamp" };
  if (!provided.length) return { ok: false, reason: "no v1 signature" };

  // The timestamp is inside the signed string, so a captured delivery cannot be
  // replayed once it falls outside this window.
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside the five-minute window" };
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const signed = Buffer.concat([Buffer.from(`${parts.t}.`, "utf8"), body]);
  const expected = crypto.createHmac("sha256", secret).update(signed).digest("hex");

  // ANY of the v1 values may match. During a secret rotation Zarokaa signs with
  // both the new and the old secret and sends both, so that a developer who has
  // not yet deployed the new secret keeps verifying successfully. Checking only
  // the first would break every rotation.
  const mine = Buffer.from(expected, "utf8");
  for (const candidate of provided) {
    const theirs = Buffer.from(candidate, "utf8");
    if (theirs.length === mine.length && crypto.timingSafeEqual(theirs, mine)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "signature mismatch" };
}

/** A small ring buffer so the demo page can show what actually arrived. */
const recent = [];
const RECENT_MAX = 50;

function remember(entry) {
  recent.unshift({ ...entry, at: new Date().toISOString() });
  if (recent.length > RECENT_MAX) recent.pop();
}

function recentDeliveries() {
  return recent.slice();
}

/**
 * Act on one verified event.
 *
 * Deliberately synchronous and trivial here. In a real app this enqueues and
 * returns — see rule 3 above.
 */
function handle(event) {
  switch (event.topic) {
    case "install.uninstalled":
      /**
       * The one webhook every app must handle. The customer removed you: your
       * tokens are already dead, and the developer agreement requires their
       * data to be deleted within 30 days.
       */
      {
        const row = store.byInstallId(event.install_id, event.installation);
        if (row) store.remove(row.key);
      }
      return `Installation ${event.install_id} removed; local data deleted.`;

    case "install.scopes_updated": {
      const installation = store.byInstallId(event.install_id, event.installation);
      if (installation) {
        // Record what was actually granted. Reading your manifest instead
        // would have you assuming permissions this customer never approved.
        store.save({
          key: installation.key,
          granted_scopes: event.data.granted_scopes || []
        });
      }
      return `Scopes now: ${(event.data.granted_scopes || []).join(", ") || "none"}.`;
    }

    case "unit.created":
    case "unit.updated":
    case "unit.deleted":
      return `Vehicle ${event.data.unit_id} ${event.topic.split(".")[1]}.`;

    case "geofence.entered":
    case "geofence.exited":
      return `Vehicle ${event.data.unit_id} ${
        event.topic === "geofence.entered" ? "entered" : "left"
      } ${event.data.geofence_name || event.data.geofence_id || "a geofence"}.`;

    case "unit.position":
      return `Vehicle ${event.data.unit_id} at ${event.data.latitude}, ${event.data.longitude}.`;

    default:
      // An unrecognised topic is NOT an error. Zarokaa adds topics additively
      // within v1, and an app that 400s on one it does not know would start
      // failing deliveries the day a new one ships.
      return `Received ${event.topic}.`;
  }
}

module.exports = { verify, handle, remember, recentDeliveries, TOLERANCE_SECONDS };
