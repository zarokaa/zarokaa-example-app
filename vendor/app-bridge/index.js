"use strict";

const {
  PROTOCOL_VERSION,
  REQUESTS,
  EVENTS,
  CONTEXT_FIELDS,
  THEME_MODES,
  REPLY_SUFFIX,
  isEnvelope,
  envelope
} = require("./protocol");

/**
 * @polygon/app-bridge — the app's only supported way to talk to its host.
 *
 * An embedded app is a cross-origin iframe. It cannot read the host's DOM, it
 * cannot share cookies with it, and it must not try: every capability it has is
 * a message the host agreed to answer. That is the point of a bridge rather than
 * a documented set of globals — the surface is enumerable, and a host can refuse
 * something without an app breaking in an undiagnosable way.
 *
 * Two things this SDK does that an app should not have to:
 *
 *  1. SESSION TOKENS EXPIRE IN 60 SECONDS. The app never handles that. It calls
 *     `getSessionToken()`, gets a live one, and the bridge refreshes from the
 *     host behind its back. An app that cached one for five minutes would spend
 *     its life debugging intermittent 401s.
 *
 *  2. ORIGIN CHECKING, in both directions. Every inbound message is matched
 *     against the host origin before it is looked at, and every outbound one
 *     names its target explicitly rather than using "*". A `postMessage` to "*"
 *     from inside an iframe broadcasts the session token to whatever page
 *     happens to be framing you.
 *
 * @example
 *   import { createApp } from "@polygon/app-bridge";
 *   const bridge = createApp({ clientId: "pgc_..." });
 *   const token = await bridge.getSessionToken();
 *   bridge.on("theme", ({ theme, tokens }) => {
 *     document.documentElement.dataset.theme = theme;
 *     for (const name in tokens) document.documentElement.style.setProperty(name, tokens[name]);
 *   });
 */

const DEFAULT_TIMEOUT_MS = 10000;
/**
 * A token is refreshed once it is within this of expiry. Ten seconds of a
 * sixty-second life: long enough to cover a slow request that has already
 * started, short enough that most calls still reuse a cached token.
 */
const REFRESH_MARGIN_MS = 10000;

class AppBridge {
  constructor(options = {}) {
    this.clientId = options.clientId || null;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.win = options.window || (typeof window !== "undefined" ? window : null);

    if (!this.win) {
      throw new BridgeError(
        "createApp() must run in a browser. Pass { window } when testing.",
        "NO_WINDOW"
      );
    }

    this.hostOrigin = resolveHostOrigin(options, this.win);
    if (!this.hostOrigin) {
      throw new BridgeError(
        "Could not determine the Polygon host origin. Polygon appends ?host=<base64url origin> " +
          "to your app URL; pass { host } explicitly if you route around it.",
        "NO_HOST"
      );
    }

    this.parent = this.win.parent;
    if (!this.parent || this.parent === this.win) {
      throw new BridgeError(
        "This page is not running inside Polygon. Open it from the Polygon App Store.",
        "NOT_EMBEDDED"
      );
    }

    this.pending = new Map();
    this.listeners = new Map();
    this.nonce = 0;
    this.session = null;
    this.sessionPromise = null;
    this.context = readContextFromUrl(this.win);
    this.destroyed = false;

    this.onMessage = this.onMessage.bind(this);
    this.win.addEventListener("message", this.onMessage);

    // Announce ourselves. The host replies with the current context, which is
    // how an app that was hard-reloaded gets its theme and locale without
    // parsing the URL it may no longer have.
    this.request(REQUESTS.HANDSHAKE, { client_id: this.clientId, version: PROTOCOL_VERSION })
      .then((payload) => {
        if (payload && payload.context) this.context = { ...this.context, ...payload.context };
      })
      .catch(() => {
        // A host that does not answer a handshake still answers everything else;
        // the handshake is an optimisation, not a precondition.
      });
  }

  /* ---------------------------------------------------------------- *
   * session
   * ---------------------------------------------------------------- */

  /**
   * A live session token, fetched or refreshed as needed.
   *
   * Concurrent callers share one in-flight refresh: without that, a page that
   * fires six requests on mount performs six token exchanges, and five of them
   * are wasted round trips against a rate limit.
   *
   * @returns {Promise<string>}
   */
  async getSessionToken() {
    if (this.session && this.session.expires_at - Date.now() > REFRESH_MARGIN_MS) {
      return this.session.token;
    }
    if (this.sessionPromise) return this.sessionPromise;

    this.sessionPromise = this.request(REQUESTS.GET_SESSION_TOKEN)
      .then((payload) => {
        if (!payload || !payload.session_token) {
          throw new BridgeError("The host did not return a session token.", "NO_SESSION");
        }
        this.session = {
          token: payload.session_token,
          expires_at: Date.now() + (payload.expires_in || 60) * 1000
        };
        return this.session.token;
      })
      .finally(() => {
        this.sessionPromise = null;
      });

    return this.sessionPromise;
  }

  /**
   * The presentation and identity context — see CONTEXT_FIELDS in protocol.js.
   *
   * Read from the URL at first paint and refreshed from the host, because the
   * URL is a convenience and the signed session token is the source of truth.
   * NEVER make an authorization decision from this — it is what the host says
   * about the current view, not a credential.
   */
  async getContext(refresh = false) {
    if (!refresh && this.context && this.context.install_id) return this.context;
    const payload = await this.request(REQUESTS.GET_CONTEXT);
    this.context = { ...this.context, ...(payload || {}) };
    return this.context;
  }

  /* ---------------------------------------------------------------- *
   * host UI
   * ---------------------------------------------------------------- */

  /** Navigate the HOST, not the iframe. `bridge.navigate({path: "/unit/123/view"})`. */
  navigate(target) {
    return this.request(REQUESTS.NAVIGATE, normaliseNavigate(target));
  }

  /** A host-rendered toast, so it appears in Polygon's own notification area. */
  toast(options) {
    const payload =
      typeof options === "string" ? { text: options } : { ...(options || {}) };
    if (!payload.text) {
      return Promise.reject(new BridgeError("toast() needs { text }", "INVALID_ARGUMENT"));
    }
    payload.tone = ["info", "success", "warning", "error"].indexOf(payload.tone) === -1 ? "info" : payload.tone;
    return this.request(REQUESTS.TOAST, payload);
  }

  /**
   * A host-rendered modal containing another page of YOUR app.
   *
   * The host owns the chrome — the overlay, the focus trap, the escape key — so
   * a modal from an app looks and behaves like a modal from Polygon. An app
   * rendering its own overlay inside the iframe can only ever cover its own
   * rectangle.
   */
  get modal() {
    const self = this;
    return {
      open(options) {
        const payload = { ...(options || {}) };
        if (!payload.path) {
          return Promise.reject(new BridgeError("modal.open() needs { path }", "INVALID_ARGUMENT"));
        }
        payload.size = ["sm", "md", "lg", "xl"].indexOf(payload.size) === -1 ? "md" : payload.size;
        return self.request(REQUESTS.MODAL_OPEN, payload);
      },
      close(result) {
        return self.request(REQUESTS.MODAL_CLOSE, { result: result === undefined ? null : result });
      }
    };
  }

  /** Show the host's own loading indicator, so a slow app does not look frozen. */
  loading(active) {
    return this.request(REQUESTS.LOADING, { active: !!active });
  }

  /**
   * Ask the host for a specific iframe height.
   *
   * Meaningful for the embedded panels of Phase 10 (a unit-detail tab); a
   * full-page app already fills the viewport and the host may ignore it. It is
   * accepted now so an app written today does not need changing then.
   */
  resize(height) {
    const value = Number(height);
    if (!Number.isFinite(value) || value <= 0) {
      return Promise.reject(new BridgeError("resize() needs a positive height", "INVALID_ARGUMENT"));
    }
    return this.request(REQUESTS.RESIZE, { height: Math.min(Math.round(value), 20000) });
  }

  /* ---------------------------------------------------------------- *
   * events
   * ---------------------------------------------------------------- */

  /**
   * Subscribe to a host event: `theme`, `locale`, `context`, `modal.closed`,
   * `suspended`.
   *
   * @returns {function} unsubscribe
   */
  on(event, handler) {
    if (typeof handler !== "function") {
      throw new BridgeError("on() needs a handler function", "INVALID_ARGUMENT");
    }
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const set = this.listeners.get(event);
    if (set) set.delete(handler);
  }

  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (e) {
        // One app's broken handler must not stop the others, and must not throw
        // inside the host's message dispatch.
        // eslint-disable-next-line no-console
        console.error("[app-bridge] listener for " + event + " threw:", e);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * transport
   * ---------------------------------------------------------------- */

  request(type, payload) {
    if (this.destroyed) {
      return Promise.reject(new BridgeError("This bridge has been destroyed.", "DESTROYED"));
    }

    const nonce = `${Date.now().toString(36)}-${++this.nonce}`;
    const message = envelope(type, payload, nonce);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(
          new BridgeError(
            `The Polygon host did not answer "${type}" within ${this.timeoutMs}ms.`,
            "TIMEOUT"
          )
        );
      }, this.timeoutMs);

      this.pending.set(nonce, { resolve, reject, timer });

      try {
        // The target origin is named explicitly. "*" would broadcast this — the
        // session token included — to whatever page is framing us.
        this.parent.postMessage(message, this.hostOrigin);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(nonce);
        reject(new BridgeError(`Could not reach the Polygon host: ${e.message}`, "POST_FAILED"));
      }
    });
  }

  onMessage(event) {
    // Origin first, before the payload is inspected at all. Anything else is a
    // parser reachable by any page on the internet.
    if (event.origin !== this.hostOrigin) return;
    if (event.source !== this.parent) return;
    if (!isEnvelope(event.data)) return;

    const { type, nonce, payload } = event.data;

    if (type.endsWith(REPLY_SUFFIX) && nonce) {
      const waiter = this.pending.get(nonce);
      if (!waiter) return;
      this.pending.delete(nonce);
      clearTimeout(waiter.timer);
      if (payload && payload.error) {
        waiter.reject(new BridgeError(payload.error.message || "Host error", payload.error.code));
      } else {
        waiter.resolve(payload);
      }
      return;
    }

    if (type === EVENTS.CONTEXT) {
      this.context = { ...this.context, ...(payload || {}) };
    }
    // Keeps getContext() current after a theme or locale push.
    if (type === EVENTS.THEME || type === EVENTS.LOCALE) {
      this.context = { ...this.context, ...contextFromEvent(type, payload || {}) };
    }
    if (type === EVENTS.SUSPENDED) {
      // Every cached token is worthless from this moment; holding one would
      // produce a confusing 403 rather than the clear state the host is
      // announcing.
      this.session = null;
    }
    this.emit(type, payload);
  }

  /** Remove the message listener and fail every in-flight request. */
  destroy() {
    this.destroyed = true;
    this.win.removeEventListener("message", this.onMessage);
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new BridgeError("The bridge was destroyed.", "DESTROYED"));
    }
    this.pending.clear();
    this.listeners.clear();
  }
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/**
 * The host origin, from `?host=<base64url origin>` unless supplied explicitly.
 *
 * Validated to be an origin and nothing more — a value carrying a path or a
 * credential means someone is trying to point the bridge somewhere, and
 * postMessage's targetOrigin only compares the origin part anyway, so accepting
 * more would create a false sense of specificity.
 */
function resolveHostOrigin(options, win) {
  if (options.host && looksLikeOrigin(options.host)) return options.host;

  const search = (win.location && win.location.search) || "";
  const params = new URLSearchParams(search);
  const raw = options.host || params.get("host");
  if (!raw) return null;

  let decoded = raw;
  if (!/^https?:\/\//i.test(raw)) {
    try {
      decoded = base64UrlDecode(raw);
    } catch (e) {
      return null;
    }
  }
  return looksLikeOrigin(decoded) ? decoded : null;
}

function looksLikeOrigin(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return url.origin === String(value).replace(/\/+$/, "");
  } catch (e) {
    return false;
  }
}

function base64UrlDecode(value) {
  const normalised = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  if (typeof atob === "function") return atob(padded);
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * First paint reads the query string so an app can render in the right theme and
 * language before its first message round trip completes. It is a convenience:
 * every one of these values is also in the signed session token, which is what
 * an app verifies.
 */
function readContextFromUrl(win) {
  const params = new URLSearchParams((win.location && win.location.search) || "");
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const themeMode = params.get("theme_mode");
  return {
    install_id: params.get("install_id") || null,
    locale: params.get("locale") || "en",
    dir: params.get("dir") === "rtl" ? "rtl" : "ltr",
    theme,
    theme_mode: THEME_MODES.indexOf(themeMode) !== -1 ? themeMode : theme,
    theme_color: params.get("theme_color") || null,
    brand: null,
    installation: params.get("installation") || null,
    tokens: null,
    font: null,
    unit_system: params.get("unit_system") === "imperial" ? "imperial" : "metric",
    timezone: params.get("timezone") || null
  };
}

function contextFromEvent(type, payload) {
  const next = {};
  if (type === EVENTS.THEME) {
    const theme = payload.theme || payload.mode;
    if (theme) next.theme = theme === "dark" ? "dark" : "light";
    if (THEME_MODES.indexOf(payload.theme_mode) !== -1) next.theme_mode = payload.theme_mode;
    const color = payload.theme_color || payload.color;
    if (color) next.theme_color = color;
    if (payload.brand) next.brand = payload.brand;
    if (payload.tokens) next.tokens = payload.tokens;
    if (payload.font) next.font = payload.font;
  } else {
    if (payload.locale) next.locale = payload.locale;
    if (payload.dir) next.dir = payload.dir === "rtl" ? "rtl" : "ltr";
  }
  return next;
}

function normaliseNavigate(target) {
  const value = typeof target === "string" ? { path: target } : { ...(target || {}) };
  if (!value.path) throw new BridgeError("navigate() needs { path }", "INVALID_ARGUMENT");
  // Host-relative only. An absolute URL here would let an app drive the top
  // frame somewhere else, which is a redirect the customer never asked for.
  if (!/^\//.test(value.path) || /^\/\//.test(value.path)) {
    throw new BridgeError(
      'navigate() takes a Polygon path such as "/unit/123/view", not an absolute URL.',
      "INVALID_ARGUMENT"
    );
  }
  return value;
}

class BridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BridgeError";
    this.code = code || "BRIDGE_ERROR";
  }
}

function createApp(options) {
  return new AppBridge(options);
}

module.exports = { createApp, AppBridge, BridgeError, PROTOCOL_VERSION, REQUESTS, EVENTS, CONTEXT_FIELDS };
module.exports.default = { createApp };
