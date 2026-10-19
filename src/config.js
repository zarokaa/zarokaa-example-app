"use strict";

/**
 * Everything the app needs from its environment, read once and validated.
 *
 * FAILS AT BOOT ON A MISSING SECRET rather than on the first customer request.
 * An app that starts happily and then throws in the middle of an OAuth callback
 * has already sent a customer through a consent screen for nothing.
 */

// `npm start` reads ./.env (as the README says); variables already in the environment win.
(function loadDotenv() {
  const file = require("path").join(__dirname, "..", ".env");
  let text;
  try {
    text = require("fs").readFileSync(file, "utf8");
  } catch (e) {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
})();

function required(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in — see the README.`
    );
  }
  return value;
}

function optional(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

const config = {
  port: Number(process.env.PORT) || 3000,

  /**
   * The public base URL of THIS app. Every redirect URI and webhook URL is
   * built from it, so getting it wrong produces an OAuth error that looks like
   * a Zarokaa problem and is not.
   */
  appBaseUrl: required("APP_BASE_URL").replace(/\/+$/, ""),

  clientId: required("ZAROKAA_CLIENT_ID"),
  clientSecret: required("ZAROKAA_CLIENT_SECRET"),

  // Dev mode (no hub): the one installation you trust. With a hub, each installation's
  // API base comes from its install token's `iss` instead.
  apiBase: optional("ZAROKAA_API_BASE", "http://localhost:8080/api/ext/v1").replace(/\/+$/, ""),

  // The Zarokaa hub whose directory lists every installation allowed to install you.
  hubUrl: optional("ZAROKAA_HUB_URL").replace(/\/+$/, ""),

  // Blank is legitimate: you have not registered a webhook endpoint yet.
  // webhooks.js refuses every delivery while it is empty rather than accepting
  // unverified ones.
  webhookSecret: optional("ZAROKAA_WEBHOOK_SECRET"),

  // Optional HTTPS listener (both or neither). Most deployments terminate TLS in front of the app instead.
  tlsCertFile: optional("TLS_CERT_FILE"),
  tlsKeyFile: optional("TLS_KEY_FILE"),

  /**
   * Default `frame-ancestors` for every page, so a plain GET (the review check) sees a restrictive
   * policy. /embed narrows it to the host that is actually framing it.
   */
  get frameAncestors() {
    const explicit = optional("APP_FRAME_ANCESTORS");
    if (explicit) return explicit;
    try {
      return new URL(this.apiBase).origin;
    } catch (e) {
      return "'self'";
    }
  },

  get redirectUri() {
    return `${this.appBaseUrl}/oauth/callback`;
  },
  get installUrl() {
    return `${this.appBaseUrl}/install`;
  },
  get webhookUrl() {
    return `${this.appBaseUrl}/webhooks/zarokaa`;
  }
};

/**
 * Zarokaa requires HTTPS for redirect URIs, with one exception for development
 * credentials. Saying so here turns a rejected authorize call into a startup
 * message that names the cause.
 */
function warnings() {
  const out = [];
  if (!/^https:/.test(config.appBaseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(config.appBaseUrl)) {
    out.push(
      `APP_BASE_URL is "${config.appBaseUrl}". Zarokaa requires HTTPS redirect URIs; ` +
        "http:// is accepted only for localhost, and only with development credentials."
    );
  }
  if (/localhost|127\.0\.0\.1/.test(config.appBaseUrl)) {
    out.push(
      "APP_BASE_URL points at localhost. Zarokaa cannot reach it to deliver webhooks, " +
        "and a customer's browser cannot be redirected to it from another machine. " +
        "Use a tunnel (see the README) for anything beyond a first look."
    );
  }
  if (!!config.tlsCertFile !== !!config.tlsKeyFile) {
    out.push("TLS_CERT_FILE and TLS_KEY_FILE must be set together; serving plain HTTP.");
  }
  if (!config.hubUrl) {
    out.push(
      "ZAROKAA_HUB_URL is not set: single-installation dev mode. Only install tokens from the " +
        `installation serving ${config.apiBase} are accepted.`
    );
  }
  if (!config.webhookSecret) {
    out.push(
      "ZAROKAA_WEBHOOK_SECRET is empty: incoming webhooks will be REFUSED. " +
        "Register an endpoint in the portal and paste the secret it shows once."
    );
  }
  return out;
}

module.exports = { config, warnings };
