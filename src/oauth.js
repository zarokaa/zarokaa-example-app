"use strict";

const crypto = require("crypto");

const { config } = require("./config");
const store = require("./store");
const { createInstallTokenVerifier } = require("./installToken");

/**
 * The OAuth 2.1 round trip, and the signed install token that precedes it.
 *
 * THE ORDER OF EVENTS, because it is not obvious from any one function here:
 *
 *   1. A customer installs your app. Zarokaa redirects their browser to your
 *      install_url with `install_token` — an RS256 JWT, five minutes, single use.
 *   2. You VERIFY it before doing anything (src/installToken.js). Skipping this
 *      means anyone who guesses a UUID can make you provision state for an
 *      installation that does not exist.
 *   3. You redirect them to that installation's authorization_endpoint with a
 *      PKCE challenge and the install_id.
 *   4. Zarokaa redirects back to your redirect_uri with a 60-second code.
 *   5. You exchange it, at the SAME installation, for tokens.
 *
 * PKCE IS MANDATORY AND S256-ONLY. `plain` is not implemented by Zarokaa and
 * never will be.
 */

/* --- PKCE ----------------------------------------------------------------- */

function createVerifier() {
  // 43-128 characters of the unreserved set. 32 random bytes in base64url is
  // 43, which is the minimum RFC 7636 allows — anything shorter is
  // brute-forceable from the challenge.
  return crypto.randomBytes(32).toString("base64url");
}

function challengeFor(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

/* --- the install token ---------------------------------------------------- */

const verifier = createInstallTokenVerifier({
  clientId: config.clientId,
  hubUrl: config.hubUrl,
  apiBase: config.apiBase
});

function verifyInstallToken(token) {
  return verifier.verify(token);
}

/**
 * Where to send the browser for /authorize. It is a page in the Zarokaa web app
 * (it needs the customer's Zarokaa session), advertised by each installation's
 * discovery document — never hardcode it.
 */
const discovery = new Map();
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

async function authorizationEndpoint(apiBase) {
  const cached = discovery.get(apiBase);
  if (cached && cached.expires > Date.now()) return cached.url;
  const res = await fetch(`${apiBase}/.well-known/oauth-authorization-server`, {
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error(`discovery answered HTTP ${res.status}`);
  const doc = await res.json();
  if (!doc.authorization_endpoint) throw new Error("discovery has no authorization_endpoint");
  discovery.set(apiBase, { url: doc.authorization_endpoint, expires: Date.now() + DISCOVERY_TTL_MS });
  return doc.authorization_endpoint;
}

/* --- authorize ------------------------------------------------------------ */

/**
 * Build the URL to send the customer's browser to.
 *
 * `state` is stored server-side with the PKCE verifier and is single-use — it
 * is the CSRF defence for the callback, and a state you do not check is a state
 * that is not defending anything.
 */
function authorizeUrl({ endpoint, key, installId, accountId, apiBase, scopes }) {
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = createVerifier();

  store.putPending(state, { verifier, key, installId, accountId, apiBase });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    code_challenge: challengeFor(verifier),
    code_challenge_method: "S256",
    state,
    // Required: it tells Zarokaa which pending installation this is.
    install_id: installId,
    // Ask for a refresh token. Without this the app can only act while the
    // customer is present, which is no use to a background job.
    access_type: "offline"
  });
  if (scopes && scopes.length) params.set("scope", scopes.join(" "));

  return `${endpoint}?${params.toString()}`;
}

/* --- token exchange ------------------------------------------------------- */

async function post(apiBase, path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString()
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const error = new Error(
      parsed.detail || parsed.error_description || parsed.title || `HTTP ${res.status}`
    );
    error.status = res.status;
    error.code = parsed.code || parsed.error;
    error.requestId = res.headers.get("x-request-id");
    throw error;
  }
  return parsed;
}

// Always at the installation that issued the code — tokens are per installation.
function exchangeCode({ code, verifier, apiBase }) {
  return post(apiBase, "/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: verifier
  });
}

function refresh(refreshToken, apiBase) {
  return post(apiBase, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret
  });
}

module.exports = {
  createVerifier,
  challengeFor,
  verifyInstallToken,
  authorizationEndpoint,
  authorizeUrl,
  exchangeCode,
  refresh
};
