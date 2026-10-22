"use strict";

const crypto = require("crypto");

/**
 * Sending a command to a tracking device, and finding out what became of it.
 *
 * A DEVICE IS NOT A WEB SERVER. It is on a mobile network, it may be asleep or
 * out of coverage, and some protocols never say whether a command ran. So the
 * POST answers `queued` with a `command_id` as soon as the command is stored,
 * and the result arrives later: a `command.completed` or `command.failed`
 * webhook (preferred), or a GET by id (the fallback below).
 *
 * Everything here except `send` and `waitForResult` is pure, so `npm test`
 * covers it with no network.
 */

const TERMINAL = new Set(["accepted", "rejected", "unconfirmed", "timeout", "expired", "failed"]);
const IN_FLIGHT = new Set(["queued", "sent"]);

/**
 * One key per INTENTION, made before the first attempt and reused on every
 * retry of it. Zarokaa then answers a retry with the original command_id instead
 * of sending the command twice — which, for an immobiliser, is the whole point.
 * A fresh key per attempt would defeat it.
 */
function newIdempotencyKey() {
  return `cmd-${crypto.randomUUID()}`;
}

function isTerminal(command) {
  if (!command) return false;
  if (typeof command.terminal === "boolean") return command.terminal;
  return TERMINAL.has(command.status);
}

/**
 * Exponential backoff with jitter, capped. Polling faster does not make a
 * device answer sooner; it only spends the installation's rate limit.
 */
function backoffMs(attempt, { baseMs = 2000, capMs = 60_000, random = Math.random } = {}) {
  const raw = Math.min(baseMs * 2 ** Math.max(0, attempt), capMs);
  return Math.round(raw * (0.8 + random() * 0.4));
}

/**
 * What a final command means for the app, in one object.
 *
 * `confirmed` is true ONLY for `accepted`. `unconfirmed` arrives on
 * command.completed because nothing went wrong that the platform can see, but
 * the device's protocol has no acknowledgement — it is not evidence the command
 * ran. Treating it as success is the bug this flag exists to prevent.
 */
function outcome(command) {
  const status = command && command.status;
  const reason = (command && command.status_reason) || null;
  const response = (command && command.response) || null;
  const data = response && response.data;
  return {
    status,
    final: isTerminal(command),
    confirmed: status === "accepted",
    failed: ["rejected", "timeout", "expired", "failed"].includes(status),
    reason: reason ? { code: reason.code || null, text: reason.text || null } : null,
    // READ_CARDS (galileosky.ibutton_list): { cards: [{ index, id }], slots }. Null when no parser matched.
    cards: data && Array.isArray(data.cards) ? data.cards : null,
    data: data === undefined ? null : data,
    raw: response ? response.raw : null,
    // The device answered but in a shape the platform did not recognise: still `accepted`, read `raw`.
    parseError: response ? response.parse_error || null : null
  };
}

/** One line for logs and the demo page's delivery table. */
function describe(command) {
  const o = outcome(command);
  const label = (command && command.command && (command.command.code || command.command.label)) || "command";
  const id = (command && command.command_id) || "?";

  if (IN_FLIGHT.has(o.status)) return `${label} ${id} is ${o.status}.`;
  if (o.status === "unconfirmed") {
    return `${label} ${id} was sent, but this device never confirms commands, so it may or may not have run.`;
  }
  if (o.failed) {
    const why = o.reason ? ` (${[o.reason.code, o.reason.text].filter(Boolean).join(": ")})` : "";
    return `${label} ${id} ${o.status}${why}.`;
  }
  if (o.status === "accepted") {
    if (o.cards) {
      const list = o.cards.length ? o.cards.map((c) => `slot ${c.index} ${c.id}`).join(", ") : "no cards";
      return `${label} ${id} accepted: ${o.cards.length} card(s) — ${list}.`;
    }
    if (o.parseError) return `${label} ${id} accepted; reply not understood (${o.parseError}): ${o.raw}`;
    return `${label} ${id} accepted${o.raw ? `: ${o.raw}` : "."}`;
  }
  return `${label} ${id}: ${o.status || "unknown status"}.`;
}

/**
 * Send with safe retries. `callFn` is api.call (key, path, options).
 *
 * Retries a network error, 429 and 5xx with the SAME key. Never a 4xx:
 * EXT_NOT_FOUND (unknown device, or not this account's — the same answer on
 * purpose), EXT_INVALID_PARAMETER or EXT_UNPROCESSABLE will not change.
 */
async function send(callFn, key, deviceId, { command, params, unitId, idempotencyKey, maxAttempts = 4, sleep = defaultSleep } = {}) {
  const body = { command };
  if (params && Object.keys(params).length) body.params = params;
  if (unitId) body.unit_id = unitId;
  const idem = idempotencyKey || newIdempotencyKey();

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await callFn(key, `/devices/${encodeURIComponent(deviceId)}/commands`, {
        method: "POST",
        body,
        idempotencyKey: idem
      });
      return { ...res.data, idempotency_key: idem }; // { command_id, status: "queued", created_at }
    } catch (e) {
      const retryable = e.status === undefined || e.retryable;
      if (!retryable || attempt + 1 >= maxAttempts) throw e;
      await sleep(e.retryAfter ? Number(e.retryAfter) * 1000 : backoffMs(attempt, { baseMs: 1000, capMs: 30_000 }));
    }
  }
}

/**
 * The poll fallback, for when no webhook is registered. Stops at a final
 * status, at a 404, or when the time budget runs out — in which case the
 * command is still queued (device offline) or sent, and the caller keeps the id.
 */
async function waitForResult(getFn, { budgetMs = 15 * 60_000, sleep = defaultSleep, now = Date.now, random } = {}) {
  const until = now() + budgetMs;
  let last = null;
  for (let attempt = 0; now() < until; attempt++) {
    const delay = Math.min(backoffMs(attempt, { random }), Math.max(0, until - now()));
    await sleep(delay);
    try {
      last = await getFn();
      if (isTerminal(last)) return { done: true, command: last };
    } catch (e) {
      if (e.status === 404) throw e;
      // Transient: back off and try again.
    }
  }
  return { done: false, command: last };
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  TERMINAL,
  newIdempotencyKey,
  isTerminal,
  backoffMs,
  outcome,
  describe,
  send,
  waitForResult
};
