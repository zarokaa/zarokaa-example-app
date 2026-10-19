"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Where installations live.
 *
 * ============================ READ THIS ============================
 * THIS IS A JSON FILE AND IT IS NOT A PRODUCTION STORE. It holds refresh
 * tokens in plaintext, has no locking, and rewrites the whole file on every
 * write. It exists so this example runs with `npm install && npm start` and
 * nothing else.
 *
 * In a real app this is a database table, and the refresh token is encrypted
 * at rest. What the SHAPE below gets right, and what you should keep:
 *
 *   - one row per (Zarokaa installation, install_id) — an installation, not a
 *     user. One app serves many Zarokaa deployments; each issues its own
 *     install ids and tokens, and each has its own API base;
 *   - the refresh token is stored SEPARATELY and rotated in place;
 *   - `granted_scopes` is recorded as consented, not assumed from your
 *     manifest, because a customer may be running on an older, narrower set.
 * ===================================================================
 */

const DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DIR, "installations.json");

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function write(all) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

function keyFor(installation, installId) {
  return `${installation}|${installId}`;
}

function get(key) {
  return read()[key] || null;
}

// For callers that only have an install_id (webhooks, the iframe); ids are UUIDs, so unique in practice.
function byInstallId(installId, installation) {
  return (
    Object.values(read()).find(
      (i) => i.install_id === installId && (!installation || i.installation === installation)
    ) || null
  );
}

function list() {
  return Object.values(read());
}

function save(installation) {
  const all = read();
  const key = installation.key || keyFor(installation.installation, installation.install_id);
  all[key] = {
    ...(all[key] || {}),
    ...installation,
    key,
    updated_at: new Date().toISOString()
  };
  write(all);
  return all[key];
}

/**
 * Store a rotated refresh token.
 *
 * SEPARATE FROM save() ON PURPOSE, and this is the single most important line
 * in the file. Zarokaa rotates the refresh token on EVERY refresh and
 * invalidates the one you sent. Presenting a rotated token again is treated as
 * theft: it revokes every token for that installation and suspends it.
 *
 * So the new token must be durably stored BEFORE the new access token is used
 * for anything. Doing it the other way round means a crash between the two
 * leaves you holding a refresh token Zarokaa has already invalidated, and the
 * installation is dead until the customer reinstalls.
 */
function saveTokens(key, tokens) {
  const all = read();
  const existing = all[key];
  if (!existing) throw new Error(`No installation ${key}`);
  all[key] = {
    ...existing,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || existing.refresh_token,
    expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString()
  };
  write(all);
  return all[key];
}

function remove(key) {
  const all = read();
  delete all[key];
  write(all);
}

/* --- pending OAuth flows -------------------------------------------------- *
 * The PKCE verifier and the state have to survive the round trip through the
 * customer's browser. In memory is right for those: they live 60 seconds, and
 * losing them to a restart costs one retried install rather than a broken one.
 * -------------------------------------------------------------------------- */

const pending = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function putPending(state, value) {
  pending.set(state, { ...value, at: Date.now() });
  // Opportunistic sweep — no timer, so the process can still exit cleanly.
  for (const [key, entry] of pending) {
    if (Date.now() - entry.at > PENDING_TTL_MS) pending.delete(key);
  }
}

function takePending(state) {
  const entry = pending.get(state);
  // Single use. A state parameter that can be replayed is not a CSRF defence.
  pending.delete(state);
  if (!entry || Date.now() - entry.at > PENDING_TTL_MS) return null;
  return entry;
}

/* --- webhook deduplication ------------------------------------------------ */

const seenEvents = new Map();
const SEEN_TTL_MS = 60 * 60 * 1000;

/**
 * Delivery is at-least-once, so the same `event_id` WILL arrive twice — on a
 * retry after your 200 was lost, and on a replay from the portal. Returns true
 * the first time only.
 */
function firstTimeSeeing(eventId) {
  const now = Date.now();
  for (const [id, at] of seenEvents) {
    if (now - at > SEEN_TTL_MS) seenEvents.delete(id);
  }
  if (seenEvents.has(eventId)) return false;
  seenEvents.set(eventId, now);
  return true;
}

module.exports = {
  keyFor,
  get,
  byInstallId,
  list,
  save,
  saveTokens,
  remove,
  putPending,
  takePending,
  firstTimeSeeing,
  FILE
};
