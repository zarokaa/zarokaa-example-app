"use strict";

const crypto = require("crypto");

/**
 * Verify the install token Zarokaa puts on your install URL.
 *
 * WHY THIS IS NOT AN HMAC ANY MORE. A Zarokaa installation never holds your
 * client secret, so it cannot sign with it. Instead it signs an RS256 JWT with
 * its own key and publishes the public half (JWKS). You verify offline:
 *
 *   1. the issuer (`iss`, the installation's API base) must be one you trust —
 *      listed in the Zarokaa hub directory, or your single ZAROKAA_API_BASE in
 *      dev mode. An attacker can stand up their own JWKS; they cannot get into
 *      the directory.
 *   2. the signature verifies against THAT issuer's JWKS, RS256 only — the
 *      algorithm is asserted, never read from the header as an instruction.
 *   3. `aud` is your client id, `exp` has not passed, `token_use` is "install".
 *   4. the `jti` has not been seen before. Zarokaa does not track install-token
 *      use; YOU are the consumer, so single use is your job. Five minutes of
 *      memory is enough because the token is dead after that anyway.
 *
 * Every remote document is cached: JWKS for 10 minutes per issuer, the
 * directory for 5. A kid you have never seen triggers one JWKS refetch, which
 * is how a key rotation reaches you without a restart.
 */

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_REFETCH_MS = 30 * 1000;
const DIRECTORY_TTL_MS = 5 * 60 * 1000;
const JTI_TTL_MS = 5 * 60 * 1000;
const SKEW_S = 5;
const FETCH_TIMEOUT_MS = 5000;

function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

function decodePart(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function createInstallTokenVerifier({ clientId, hubUrl, apiBase, fetchImpl, now } = {}) {
  const doFetch = fetchImpl || ((url) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
  const clock = now || Date.now;
  const jwksCache = new Map();
  const seenJti = new Map();
  let directory = null;

  async function getJson(url) {
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
    return res.json();
  }

  async function directoryEntries() {
    if (directory && directory.expires > clock()) return directory.entries;
    const body = await getJson(`${trimSlash(hubUrl)}/api/registry/v1/directory`);
    const entries = Array.isArray(body) ? body : body.data || body.installations || [];
    directory = { entries, expires: clock() + DIRECTORY_TTL_MS };
    return entries;
  }

  // Returns the directory entry (or a dev-mode stand-in) for a trusted issuer, else null.
  async function trustedIssuer(iss) {
    if (typeof iss !== "string" || !/^https?:\/\//.test(iss)) return null;
    const issuer = trimSlash(iss);
    if (!hubUrl) {
      // Single-installation dev mode: exactly the deployment you configured.
      return `${issuer}/ext/v1` === trimSlash(apiBase) ? { code: null, api_base: issuer } : null;
    }
    const entries = await directoryEntries();
    return (
      entries.find((e) => {
        const bases = [e.api_base].concat(Array.isArray(e.api_bases) ? e.api_bases : []);
        return bases.some((b) => b && trimSlash(b) === issuer);
      }) || null
    );
  }

  async function publicKey(issuer, kid) {
    const cached = jwksCache.get(issuer);
    let keys = cached && cached.expires > clock() ? cached.keys : null;
    // An unknown kid refetches at most every 30 s, so junk tokens cannot hammer the issuer.
    const mayRefetch = !cached || clock() - cached.fetchedAt > JWKS_REFETCH_MS;
    if (!keys || (!keys.find((k) => k.kid === kid) && mayRefetch)) {
      const body = await getJson(`${issuer}/ext/v1/.well-known/jwks.json`);
      keys = Array.isArray(body.keys) ? body.keys : [];
      jwksCache.set(issuer, { keys, expires: clock() + JWKS_TTL_MS, fetchedAt: clock() });
    }
    const jwk = keys.find((k) => k.kid === kid && k.kty === "RSA");
    return jwk ? crypto.createPublicKey({ key: jwk, format: "jwk" }) : null;
  }

  function consumeJti(jti, expS) {
    const nowMs = clock();
    for (const [id, until] of seenJti) if (until <= nowMs) seenJti.delete(id);
    if (seenJti.has(jti)) return false;
    seenJti.set(jti, Math.max(nowMs + JTI_TTL_MS, expS * 1000 + SKEW_S * 1000));
    return true;
  }

  async function verify(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed install token" };

    let header;
    let claims;
    try {
      header = decodePart(parts[0]);
      claims = decodePart(parts[1]);
    } catch (e) {
      return { ok: false, reason: "malformed install token" };
    }
    if (header.alg !== "RS256") return { ok: false, reason: "unsupported algorithm" };

    let entry;
    try {
      entry = await trustedIssuer(claims.iss);
    } catch (e) {
      return { ok: false, reason: `could not load the Zarokaa directory: ${e.message}` };
    }
    if (!entry) return { ok: false, reason: "issuer is not a known Zarokaa installation" };

    const issuer = trimSlash(claims.iss);
    let key;
    try {
      key = await publicKey(issuer, header.kid);
    } catch (e) {
      return { ok: false, reason: `could not load the issuer's keys: ${e.message}` };
    }
    if (!key) return { ok: false, reason: "unknown signing key" };

    const valid = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], "base64url")
    );
    if (!valid) return { ok: false, reason: "signature does not verify" };

    const nowS = Math.floor(clock() / 1000);
    if (claims.aud !== clientId) return { ok: false, reason: "token was not issued for this app" };
    if (typeof claims.exp !== "number" || claims.exp + SKEW_S < nowS) return { ok: false, reason: "token has expired" };
    if (typeof claims.iat === "number" && claims.iat - SKEW_S > nowS) return { ok: false, reason: "token is not yet valid" };
    if (claims.token_use !== undefined && claims.token_use !== "install") return { ok: false, reason: "not an install token" };
    if (!claims.install_id || !claims.jti) return { ok: false, reason: "token is missing install_id or jti" };
    if (entry.code && claims.installation && claims.installation !== entry.code) {
      return { ok: false, reason: "installation does not match the issuer" };
    }
    // Last, so a forged token cannot burn a real jti.
    if (!consumeJti(claims.jti, claims.exp)) return { ok: false, reason: "install token has already been used" };

    return {
      ok: true,
      claims,
      issuer,
      installation: claims.installation || entry.code || issuer,
      apiBase: `${issuer}/ext/v1`
    };
  }

  return { verify };
}

module.exports = { createInstallTokenVerifier, JWKS_TTL_MS, DIRECTORY_TTL_MS, JTI_TTL_MS };
