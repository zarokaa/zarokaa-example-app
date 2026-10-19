"use strict";

const fs = require("fs");
const https = require("https");
const path = require("path");
const express = require("express");

const { config, warnings } = require("./config");
const oauth = require("./oauth");
const store = require("./store");
const webhooks = require("./webhooks");
const { api, ZarokaaError } = require("./api");
const { esc, page, presentation, notice, unitsTable, deliveriesTable } = require("./views");

const app = express();

// HSTS whenever this process terminates TLS itself; a restrictive frame-ancestors on every page.
app.use((req, res, next) => {
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  res.setHeader("Content-Security-Policy", `frame-ancestors ${config.frameAncestors}`);
  next();
});

/**
 * THE WEBHOOK ROUTE IS MOUNTED BEFORE express.json(), WITH express.raw().
 *
 * This ordering is the whole reason webhook signature verification works. Once
 * a JSON body parser has run, the original bytes are gone, and re-serialising
 * the parsed object produces different bytes — different key order, different
 * whitespace — so the HMAC never matches. Mounting the raw parser on this one
 * path keeps `req.body` a Buffer exactly as Zarokaa sent it.
 *
 * Move this below `app.use(express.json())` and every delivery fails
 * verification with no other symptom. It is the first thing to check.
 */
app.post(
  "/webhooks/zarokaa",
  express.raw({ type: "application/json", limit: "1mb" }),
  (req, res) => {
    const signature = req.get("X-Polygon-Signature");
    const result = webhooks.verify(req.body, signature);

    if (!result.ok) {
      // 401, not 400. A 4xx that is not 408/429 tells Zarokaa not to retry,
      // which is right: a bad signature will not become good on the third try.
      webhooks.remember({ topic: req.get("X-Polygon-Topic") || "?", ok: false, result: result.reason });
      console.warn(`[webhook] refused: ${result.reason}`);
      return res.status(401).json({ error: result.reason });
    }

    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch (e) {
      return res.status(400).json({ error: "body is not JSON" });
    }

    // Delivery is at-least-once. The same id arrives again after a lost 200 and
    // on every replay from the portal.
    if (!store.firstTimeSeeing(event.id)) {
      console.log(`[webhook] duplicate ${event.id} (${event.topic}) — acknowledged, not reprocessed`);
      return res.status(200).json({ ok: true, duplicate: true });
    }

    let outcome;
    try {
      outcome = webhooks.handle(event);
    } catch (e) {
      // Answering 500 asks Zarokaa to retry, which is what you want for a
      // transient failure — and what you do NOT want for a bug that will fail
      // identically eight more times. Real apps enqueue and answer 200.
      console.error(`[webhook] handler threw for ${event.topic}:`, e.message);
      return res.status(500).json({ error: "handler failed" });
    }

    webhooks.remember({ topic: event.topic, ok: true, result: outcome });
    console.log(`[webhook] ${event.topic} — ${outcome}`);
    res.status(200).json({ ok: true });
  }
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/**
 * Serve the app bridge to the browser as a single ES module.
 *
 * WHY THIS ROUTE EXISTS. `@polygon/app-bridge` ships CommonJS, and a browser
 * cannot `import` that. Every real app has a bundler that handles it — this
 * example deliberately has none, so that a developer can read every file and
 * run it with two commands. Concatenating the SDK's two source files behind a
 * four-line CommonJS shim gets the REAL bridge into the browser without a build
 * step, and without a CDN dependency in a page that handles session tokens.
 *
 * In your own app: copy vendor/app-bridge into your source, import it through
 * your bundler and delete this route. The bridge is not on the public npm
 * registry — see vendor/app-bridge/README.md.
 *
 * Read once at boot rather than per request — it is a static file, and an fs
 * read on every iframe load is a needless syscall.
 */
const bridgeModule = (() => {
  const dir = path.join(__dirname, "..", "vendor", "app-bridge");
  const protocol = fs.readFileSync(path.join(dir, "protocol.js"), "utf8");
  const index = fs.readFileSync(path.join(dir, "index.js"), "utf8");
  /**
   * Each CommonJS file is evaluated inside its OWN IIFE, and the exports are
   * read off the returned object.
   *
   * The obvious shim — paste the source at top level, then
   * `export const createApp = module.exports.createApp` — does not work: the
   * SDK declares `function createApp` at top level too, so the export collides
   * with it and the module fails to compile with "Identifier 'createApp' has
   * already been declared". Scoping each file keeps its declarations to itself.
   */
  return `// Generated at boot from vendor/app-bridge — do not edit.
const __protocol = (() => {
  const module = { exports: {} };
  const exports = module.exports;
${protocol}
  return module.exports;
})();

const __bridge = (() => {
  const module = { exports: {} };
  const exports = module.exports;
  const require = (name) => {
    if (name === "./protocol") return __protocol;
    throw new Error("unexpected require: " + name);
  };
${index}
  return module.exports;
})();

export const createApp = __bridge.createApp;
export const AppBridge = __bridge.AppBridge;
export const BridgeError = __bridge.BridgeError;
export const PROTOCOL_VERSION = __bridge.PROTOCOL_VERSION;
export default { createApp: __bridge.createApp };
`;
})();

app.get("/vendor/app-bridge.js", (req, res) => {
  res.type("application/javascript").send(bridgeModule);
});

/* ------------------------------------------------------------------ *
 * 1. Install — where Zarokaa sends the customer first
 * ------------------------------------------------------------------ */

app.get("/install", async (req, res) => {
  /**
   * VERIFY BEFORE PROVISIONING. Without this check anyone who guesses a UUID
   * can make this app create state for an installation that does not exist —
   * and, worse, start an OAuth flow naming it. See src/installToken.js.
   */
  const check = await oauth.verifyInstallToken(req.query.install_token);
  if (!check.ok) {
    console.warn(`[install] refused install token: ${check.reason}`);
    return res
      .status(400)
      .send(page("Install refused", notice("bad", `That install link could not be verified: ${esc(check.reason)}.`)));
  }

  const { claims, installation, apiBase } = check;
  const saved = store.save({
    installation,
    issuer: check.issuer,
    api_base: apiBase,
    install_id: claims.install_id,
    account_id: claims.account_id,
    scope_mode: claims.scope_mode,
    status: "pending",
    installed_at: new Date().toISOString()
  });

  let endpoint;
  try {
    endpoint = await oauth.authorizationEndpoint(apiBase);
  } catch (e) {
    console.error(`[install] discovery failed for ${apiBase}: ${e.message}`);
    return res
      .status(502)
      .send(page("Install failed", notice("bad", `Could not reach ${esc(apiBase)}: ${esc(e.message)}`)));
  }

  res.redirect(
    oauth.authorizeUrl({
      endpoint,
      key: saved.key,
      installId: claims.install_id,
      accountId: claims.account_id,
      apiBase
    })
  );
});

/* ------------------------------------------------------------------ *
 * 2. OAuth callback — exchange the code for tokens
 * ------------------------------------------------------------------ */

app.get("/oauth/callback", async (req, res) => {
  if (req.query.error) {
    return res
      .status(400)
      .send(page("Authorisation failed", notice("bad", esc(req.query.error_description || req.query.error))));
  }

  // Single-use, and gone from the store the moment it is read.
  const pending = store.takePending(req.query.state);
  if (!pending) {
    return res
      .status(400)
      .send(page("Authorisation failed", notice("bad", "Unknown or expired <code>state</code>. Start the install again.")));
  }

  try {
    const tokens = await oauth.exchangeCode({
      code: req.query.code,
      verifier: pending.verifier,
      apiBase: pending.apiBase
    });

    store.save({
      key: pending.key,
      account_id: tokens.account_id || pending.accountId,
      status: "active",
      // Recorded as GRANTED, never assumed from the manifest — this customer
      // may be running on an older, narrower set than you now request.
      granted_scopes: (tokens.scope || "").split(" ").filter(Boolean)
    });
    store.saveTokens(pending.key, tokens);

    res.send(
      page(
        "Installed",
        notice("good", "Installed. Open the app from the Zarokaa sidebar, or use the panel below.") +
          `<p><a class="btn" href="/?install=${encodeURIComponent(pending.key)}">Open the demo panel</a></p>`
      )
    );
  } catch (e) {
    console.error("[oauth] token exchange failed:", e.message, e.requestId || "");
    res
      .status(502)
      .send(
        page(
          "Authorisation failed",
          notice("bad", `Token exchange failed: ${esc(e.message)}`) +
            (e.requestId ? `<p class="muted small">Zarokaa request id <code>${esc(e.requestId)}</code></p>` : "")
        )
      );
  }
});

/* ------------------------------------------------------------------ *
 * 3. The embedded UI — what Zarokaa renders in its iframe
 * ------------------------------------------------------------------ */

app.get("/embed", (req, res) => {
  /**
   * `frame-ancestors` is REQUIRED. Without it the browser refuses to frame this
   * page and the customer sees an empty panel with nothing in the console to
   * explain it. Zarokaa checks it at review and re-checks it periodically.
   *
   * The host origin arrives base64url-encoded in `host`; echoing it back is
   * what lets one deployment serve several Zarokaa hosts.
   */
  const hostParam = String(req.query.host || "");
  let hostOrigin = "";
  try {
    hostOrigin = Buffer.from(hostParam, "base64url").toString("utf8");
    // Only an origin. Anything with a path is not one, and is not trusted.
    const parsed = new URL(hostOrigin);
    hostOrigin = parsed.origin;
  } catch (e) {
    hostOrigin = "";
  }
  if (hostOrigin) {
    res.setHeader("Content-Security-Policy", `frame-ancestors ${hostOrigin}`);
  }

  res.send(
    page(
      "Fleet Snapshot",
      `<div id="app"><p class="muted">Connecting…</p></div>
       <script type="module" src="/embed.js"></script>`,
      { embedded: true, ...presentation(req.query) }
    )
  );
});

/* ------------------------------------------------------------------ *
 * 4. This app's own API — the embedded page calls THIS, never Zarokaa
 * ------------------------------------------------------------------ */

/**
 * The browser never holds a Zarokaa access token.
 *
 * The embedded page asks the bridge for a short-lived SESSION token, sends that
 * here, and this server exchanges its own stored access token for the data. A
 * page that called Zarokaa directly would need an access token in the browser,
 * where any script on it could read one — which is the point of the session
 * exchange existing at all.
 */
app.get("/api/units", async (req, res) => {
  const key = resolveKey(req.query);
  if (!key) return res.status(404).json({ error: "no installation" });

  try {
    const result = await api.listUnits(key, 25);
    res.json(result);
  } catch (e) {
    if (e instanceof ZarokaaError) {
      return res.status(e.status || 502).json({
        error: e.message,
        code: e.code,
        request_id: e.requestId,
        retryable: e.retryable
      });
    }
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ *
 * 5. A plain page, so the app is useful before it is embedded
 * ------------------------------------------------------------------ */

app.get("/", async (req, res) => {
  const installations = store.list();
  const key = resolveKey(req.query);

  const setup = warnings().length
    ? notice(
        "warn",
        "<strong>Configuration</strong><ul>" +
          warnings().map((w) => `<li>${esc(w)}</li>`).join("") +
          "</ul>"
      )
    : "";

  if (!key) {
    return res.send(
      page(
        "Fleet Snapshot",
        setup +
          notice("info", "No installation yet.") +
          `<p>Register this app in the developer portal with:</p>
           <ul class="mono small">
             <li>Install URL — <code>${esc(config.installUrl)}</code></li>
             <li>Redirect URI — <code>${esc(config.redirectUri)}</code></li>
             <li>App URL — <code>${esc(config.appBaseUrl)}/embed</code></li>
             <li>Webhook URL — <code>${esc(config.webhookUrl)}</code></li>
           </ul>
           <p class="muted">Then install it on a Zarokaa account you own, or one that invited you as a tester.</p>`
      )
    );
  }

  let unitsHtml;
  try {
    const result = await api.listUnits(key, 25);
    unitsHtml = unitsTable(result.data || []);
  } catch (e) {
    unitsHtml = notice(
      "bad",
      `Could not list vehicles: ${esc(e.message)}` +
        (e.code ? ` <code>${esc(e.code)}</code>` : "") +
        (e.requestId ? `<div class="muted small">Zarokaa request id ${esc(e.requestId)}</div>` : "")
    );
  }

  res.send(
    page(
      "Fleet Snapshot",
      setup +
        `<p class="muted small">Installation <code>${esc(key)}</code> · ${installations.length} installed</p>
         <h2>Vehicles</h2>${unitsHtml}
         <h2>Webhook deliveries</h2>${deliveriesTable(webhooks.recentDeliveries())}`
    )
  );
});

app.get("/health", (req, res) =>
  res.json({ status: "ok", installations: store.list().length, warnings: warnings() })
);

// ?install=<store key>, or ?install_id (+ ?installation) from the iframe, or the first one for the demo page.
function resolveKey(query) {
  if (query.install && store.get(String(query.install))) return String(query.install);
  if (query.install_id) {
    const id = String(query.install_id);
    const row = (query.installation && store.byInstallId(id, String(query.installation))) || store.byInstallId(id);
    return row ? row.key : null;
  }
  const all = store.list();
  return all.length ? all[0].key : null;
}

if (require.main === module) {
  const tls = config.tlsCertFile && config.tlsKeyFile;
  const server = tls
    ? https.createServer({ cert: fs.readFileSync(config.tlsCertFile), key: fs.readFileSync(config.tlsKeyFile) }, app)
    : app;
  server.listen(config.port, () => {
    console.log(`\nFleet Snapshot listening on ${tls ? "https" : "http"}://localhost:${config.port}`);
    console.log(`  public base   ${config.appBaseUrl}`);
    console.log(`  install URL   ${config.installUrl}`);
    console.log(`  redirect URI  ${config.redirectUri}`);
    console.log(`  webhook URL   ${config.webhookUrl}`);
    console.log(`  trust         ${config.hubUrl ? `hub directory ${config.hubUrl}` : `dev mode, ${config.apiBase} only`}`);
    for (const w of warnings()) console.warn(`  ! ${w}`);
    console.log("");
  });
}

module.exports = app;
