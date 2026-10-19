"use strict";

/**
 * The postMessage protocol, shared by the SDK and the host.
 *
 * Kept in one file that both sides import so the two cannot drift. A host that
 * answers a message shape the SDK no longer sends is a bug nobody notices until
 * an app upgrades.
 *
 * Every message carries `{v, type, nonce, payload}`. The nonce pairs a reply
 * with its request; without one, two concurrent `getSessionToken()` calls
 * resolve with each other's answers roughly half the time.
 */

const PROTOCOL_VERSION = 1;

/** App → host. */
const REQUESTS = {
  HANDSHAKE: "handshake",
  GET_SESSION_TOKEN: "getSessionToken",
  GET_CONTEXT: "getContext",
  NAVIGATE: "navigate",
  TOAST: "toast",
  MODAL_OPEN: "modal.open",
  MODAL_CLOSE: "modal.close",
  LOADING: "loading",
  RESIZE: "resize"
};

/** Host → app, unsolicited. */
const EVENTS = {
  // {theme, theme_mode, theme_color, brand, tokens, font} plus the v1.0 aliases mode (= theme) and color (= theme_color).
  THEME: "theme",
  // {locale, dir}; also sent when only the direction changes.
  LOCALE: "locale",
  // A partial CONTEXT_FIELDS object, merged into the app's context.
  CONTEXT: "context",
  MODAL_CLOSED: "modal.closed",
  SUSPENDED: "suspended"
};

/**
 * What handshake/getContext return. Protocol v1, additive since 1.1:
 *   install_id, locale, dir ("ltr"|"rtl"), unit_system ("metric"|"imperial"), timezone (IANA)
 *   theme        resolved "light"|"dark" — what Polygon is showing now
 *   theme_mode   "light"|"dark"|"auto" — the user's choice; "auto" follows the OS     (1.1)
 *   theme_color  the deployment's accent colour (white-label aware)
 *   brand        {name, logo_url} of the (white-label) deployment                      (1.1)
 *   installation the Polygon installation code, when the deployment has one            (1.1)
 *   tokens       {"--polygon-primary", "--polygon-surface", "--polygon-text", "--polygon-border",
 *                 "--polygon-radius", "--polygon-space-1".."--polygon-space-4"} resolved to
 *                 concrete CSS values, for document.documentElement.style.setProperty (1.1)
 *   font         {family: ["Noto Sans", "Noto Sans Hebrew", …], stylesheet?: https URL}: the host's
 *                 font stack, scripts included, and the stylesheet that loads it         (1.2)
 */
const CONTEXT_FIELDS = [
  "install_id",
  "locale",
  "dir",
  "theme",
  "theme_mode",
  "theme_color",
  "brand",
  "installation",
  "tokens",
  "font",
  "unit_system",
  "timezone"
];

const THEME_MODES = ["light", "dark", "auto"];

const REPLY_SUFFIX = ":reply";

function isEnvelope(data) {
  return !!(
    data &&
    typeof data === "object" &&
    data.v === PROTOCOL_VERSION &&
    typeof data.type === "string"
  );
}

function envelope(type, payload, nonce) {
  return { v: PROTOCOL_VERSION, type, nonce: nonce || null, payload: payload || null };
}

module.exports = {
  PROTOCOL_VERSION,
  REQUESTS,
  EVENTS,
  CONTEXT_FIELDS,
  THEME_MODES,
  REPLY_SUFFIX,
  isEnvelope,
  envelope
};
