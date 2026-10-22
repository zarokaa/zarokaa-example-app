"use strict";

// Required explicitly rather than leaning on the global `crypto`, which is only
// stable from Node 19 — this app declares Node >= 18.
const crypto = require("crypto");

const { config } = require("./config");
const oauth = require("./oauth");
const store = require("./store");
const commands = require("./commands");

/**
 * The Zarokaa API client.
 *
 * WHAT MAKES THIS MORE THAN `fetch`, and why each part is here:
 *
 *   - IT REFRESHES BEFORE EXPIRY, not after a 401. Reacting to a 401 means
 *     every token expiry costs a wasted round trip and a log line that looks
 *     like an auth failure.
 *   - IT SERIALISES REFRESHES PER INSTALLATION. Zarokaa rotates the refresh
 *     token on every use and treats a reuse as theft — so two concurrent
 *     requests both deciding to refresh would suspend the installation. The
 *     in-flight map below is the whole defence, and it is the bug most apps
 *     ship with.
 *   - IT DISTINGUISHES "RETRY THIS" FROM "STOP". A 429 has a Retry-After and is
 *     worth waiting for; an EXT_INSUFFICIENT_SCOPE never will be.
 */

/** installation key → Promise, so concurrent callers await one refresh. */
const refreshing = new Map();

class ZarokaaError extends Error {
  constructor(problem, status, requestId) {
    super(problem.detail || problem.title || `HTTP ${status}`);
    this.name = "ZarokaaError";
    this.code = problem.code || "EXT_INTERNAL";
    this.status = status;
    // Quote this in a support request; it is in Zarokaa's logs too.
    this.requestId = requestId || problem.request_id;
    this.retryAfter = problem.retry_after;
  }

  /** Whether trying the same call again could ever succeed. */
  get retryable() {
    if (this.status === 429) return true;
    if (this.status >= 500) return true;
    return false;
  }
}

function apiBaseFor(installation) {
  return installation.api_base || config.apiBase;
}

async function accessTokenFor(key) {
  const installation = store.get(key);
  if (!installation) throw new Error(`No installation ${key}`);

  // 60 seconds of headroom: a token that expires while the request is in
  // flight fails for no reason.
  const expiresAt = new Date(installation.expires_at || 0).getTime();
  if (expiresAt - Date.now() > 60_000) return installation.access_token;

  if (refreshing.has(key)) return refreshing.get(key);

  const promise = (async () => {
    try {
      const tokens = await oauth.refresh(installation.refresh_token, apiBaseFor(installation));
      // Stored BEFORE the new access token is handed back — see the comment on
      // store.saveTokens for why this order is not optional.
      const updated = store.saveTokens(key, tokens);
      return updated.access_token;
    } finally {
      refreshing.delete(key);
    }
  })();

  refreshing.set(key, promise);
  return promise;
}

/**
 * @param {string} key   store key: (Zarokaa installation, install_id)
 * @param {string} path  e.g. "/units?page_size=25"
 */
async function call(key, path, { method = "GET", body, idempotencyKey } = {}) {
  const token = await accessTokenFor(key);
  const installation = store.get(key);

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json"
  };
  if (body) headers["Content-Type"] = "application/json";
  // Mutating verbs REQUIRE this header — a missing one is a 400, not a silent
  // success. A fresh key per logical attempt; reuse it when retrying the SAME
  // attempt, which is what makes the retry safe.
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers["Idempotency-Key"] = idempotencyKey || crypto.randomUUID();
  }

  // The installation's own API base, from its install token — never one global URL.
  const res = await fetch(`${apiBaseFor(installation)}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (e) {
    parsed = { title: "Response was not JSON", raw: text.slice(0, 500) };
  }

  if (!res.ok) throw new ZarokaaError(parsed, res.status, res.headers.get("x-request-id"));
  return parsed;
}

/* --- the handful of calls this example makes ------------------------------ */

const api = {
  listUnits: (key, pageSize = 25) =>
    call(key, `/units?page_size=${pageSize}`),

  getUnit: (key, unitId) => call(key, `/units/${unitId}`),

  listTrips: (key, unitId) =>
    call(key, `/units/${unitId}/trips?page_size=10`),

  /**
   * Register a webhook endpoint. The response is the ONLY time the signing
   * secret is ever shown — there is no endpoint that reads it back.
   */
  createWebhook: (key, url, topics) =>
    call(key, "/webhooks", {
      method: "POST",
      body: { url, topics, description: "zarokaa-example-app" }
    }),

  listWebhooks: (key) => call(key, "/webhooks"),

  listDevices: (key, pageSize = 25) => call(key, `/devices?page_size=${pageSize}`),

  /**
   * Queue a command (devices.commands:execute). Answers `queued` at once; the
   * result comes by webhook or getCommand. Pass the same idempotencyKey to
   * retry the same intention — see src/commands.js.
   */
  sendCommand: (key, deviceId, options) => commands.send(call, key, deviceId, options),

  getCommand: (key, deviceId, commandId) =>
    call(key, `/devices/${encodeURIComponent(deviceId)}/commands/${encodeURIComponent(commandId)}`),

  listCommands: (key, deviceId, status) =>
    call(key, `/devices/${encodeURIComponent(deviceId)}/commands?page_size=10${status ? `&status=${encodeURIComponent(status)}` : ""}`),

  /** What the customer sees in their App Store as your billing state. */
  setEntitlement: (key, entitlement) =>
    call(key, "/me/entitlement", { method: "PUT", body: entitlement })
};

module.exports = { call, api, ZarokaaError, accessTokenFor };
