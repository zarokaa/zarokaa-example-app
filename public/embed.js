/**
 * The embedded page, talking to Zarokaa through the app bridge.
 *
 * WHAT THE BRIDGE IS FOR. This page runs in an iframe on the customer's Zarokaa
 * tab. It cannot read that page, and Zarokaa cannot read this one — so anything
 * the two need to agree on (who is signed in, which theme, which language, "open
 * this vehicle in the host") goes through a versioned, origin-checked
 * postMessage protocol. `@polygon/app-bridge` is that protocol. Raw postMessage
 * is not a contract and will break.
 *
 * THE SESSION TOKEN IS NOT AN ACCESS TOKEN. It is short-lived, audience-bound,
 * and grants nothing on its own: it is proof of who is looking at this page,
 * which this app's own server exchanges for data using the credentials it
 * holds. That is why the fetch below goes to /api/units on THIS server rather
 * than to Zarokaa.
 *
 * LOOKING LIKE PART OF ZAROKAA. The host tells the app its theme (light/dark,
 * resolved even when the customer picked "auto"), its design tokens, its font
 * stack and its language and direction — at launch and again whenever any of
 * them changes. A panel that ignores them looks like a foreign object, and one
 * that ignores `dir` is unreadable in Hebrew.
 */

// Served by this app's own server from vendor/app-bridge — no bundler, no CDN.
// In a bundled app, import the same files from wherever you copied vendor/app-bridge.
import { createApp } from "/vendor/app-bridge.js";

const root = document.getElementById("app");
const html = document.documentElement;

/**
 * The app's own strings, in every language Zarokaa ships. Zarokaa sends the
 * customer's locale; it does not translate the app for you. Anything missing in
 * a language falls back to English rather than showing a key.
 */
const MESSAGES = {
  en: {
    connecting: "Connecting to Zarokaa…",
    hostUnreachable: "Could not reach the Zarokaa host: {error}",
    suspended: "This app has been suspended.",
    requestFailed: "Request failed",
    requestId: "Zarokaa request id {id}",
    noVehicles: "No vehicles on this account.",
    vehicles: { one: "{n} vehicle", other: "{n} vehicles" },
    navigateHint: "Selecting a vehicle opens it in Zarokaa.",
    opening: "Opening the vehicle in Zarokaa",
    lastPosition: "Last position",
    neverReported: "never reported",
    status: { ACTIVE: "Active", INACTIVE: "Inactive", BLOCKED: "Blocked" }
  },
  ru: {
    connecting: "Подключение к Zarokaa…",
    hostUnreachable: "Не удалось связаться с Zarokaa: {error}",
    suspended: "Работа этого приложения приостановлена.",
    requestFailed: "Запрос не выполнен",
    requestId: "Идентификатор запроса Zarokaa {id}",
    noVehicles: "В этой учётной записи нет транспортных средств.",
    vehicles: {
      one: "{n} транспортное средство",
      few: "{n} транспортных средства",
      many: "{n} транспортных средств",
      other: "{n} транспортного средства"
    },
    navigateHint: "Выберите транспортное средство, чтобы открыть его в Zarokaa.",
    opening: "Открываем транспортное средство в Zarokaa",
    lastPosition: "Последнее местоположение",
    neverReported: "нет данных",
    status: { ACTIVE: "Активно", INACTIVE: "Неактивно", BLOCKED: "Заблокировано" }
  },
  he: {
    connecting: "מתחבר ל-Zarokaa…",
    hostUnreachable: "לא ניתן להתחבר ל-Zarokaa: {error}",
    suspended: "השימוש באפליקציה זו הושעה.",
    requestFailed: "הבקשה נכשלה",
    requestId: "מזהה בקשה ב-Zarokaa {id}",
    noVehicles: "אין רכבים בחשבון זה.",
    vehicles: { one: "רכב אחד", two: "{n} רכבים", other: "{n} רכבים" },
    navigateHint: "בחירת רכב פותחת אותו ב-Zarokaa.",
    opening: "פותח את הרכב ב-Zarokaa",
    lastPosition: "מיקום אחרון",
    neverReported: "לא דווח",
    status: { ACTIVE: "פעיל", INACTIVE: "לא פעיל", BLOCKED: "חסום" }
  }
};

let locale = "en";

function language(tag) {
  const base = String(tag || "en").toLowerCase().split(/[-_]/)[0];
  return MESSAGES[base] ? base : "en";
}

function lookup(key) {
  const path = key.split(".");
  const find = (dict) => path.reduce((node, part) => (node == null ? node : node[part]), dict);
  const hit = find(MESSAGES[language(locale)]);
  return hit !== undefined ? hit : find(MESSAGES.en);
}

function t(key, vars = {}) {
  let value = lookup(key);
  if (value && typeof value === "object" && "n" in vars) {
    const rule = new Intl.PluralRules(locale).select(vars.n);
    value = value[rule] || value.other;
    vars = { ...vars, n: new Intl.NumberFormat(locale).format(vars.n) };
  }
  if (typeof value !== "string") return key;
  return value.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

function escape(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/* ---------------------------------------------------------------- *
 * Presentation: theme, tokens, font, language and direction
 * ---------------------------------------------------------------- */

function applyTheme({ theme, tokens, font }) {
  if (theme) html.dataset.theme = theme === "dark" ? "dark" : "light";
  // Every token is a concrete CSS value (Zarokaa resolves its own variables first).
  // Only --polygon-* names are applied, so a host can never overwrite the app's own variables.
  if (tokens) {
    for (const [name, value] of Object.entries(tokens)) {
      if (name.startsWith("--polygon-")) html.style.setProperty(name, value);
    }
  }
  if (font) applyFont(font);
}

/**
 * The host's font stack, scripts included: Zarokaa lists a Hebrew (and other
 * script) family after the Latin one so per-glyph fallback picks it up. Loading
 * the host's stylesheet is what makes those families exist inside this frame —
 * an iframe does not inherit fonts from the page around it.
 */
function applyFont({ family, stylesheet }) {
  if (Array.isArray(family) && family.length) {
    const generic = new Set(["serif", "sans-serif", "monospace", "system-ui", "cursive", "fantasy"]);
    const stack = family.map((name) => (generic.has(name) ? name : `"${name.replace(/["\\]/g, "")}"`));
    html.style.setProperty("--app-font", `${stack.join(", ")}, var(--app-font-fallback)`);
  }
  if (stylesheet && /^https:\/\//.test(stylesheet)) {
    let link = document.getElementById("host-font");
    if (!link) {
      link = document.createElement("link");
      link.id = "host-font";
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    if (link.href !== stylesheet) link.href = stylesheet;
  }
}

function applyLocale({ locale: next, dir }) {
  if (next) locale = next;
  html.lang = locale;
  html.dir = dir === "rtl" ? "rtl" : "ltr";
}

/* ---------------------------------------------------------------- *
 * Rendering
 * ---------------------------------------------------------------- */

// Kept so a language switch re-renders what is on screen without refetching.
let view = { kind: "message", key: "connecting" };

function show(next) {
  view = next;
  root.innerHTML = renderView(view);
  bindUnits();
}

function renderView(v) {
  switch (v.kind) {
    case "message":
      return `<p class="muted">${escape(t(v.key, v.vars))}</p>`;
    case "error":
      return (
        `<div class="notice notice--bad">${escape(v.text || t(v.key, v.vars))}` +
        (v.requestId ? `<div class="muted small">${escape(t("requestId", { id: v.requestId }))}</div>` : "") +
        `</div>`
      );
    case "suspended":
      return `<div class="notice notice--bad">${escape(t("suspended"))} ${escape(v.reason || "")}</div>`;
    case "units":
      return renderUnits(v.units);
    default:
      return "";
  }
}

function renderUnits(units) {
  if (!units.length) return `<p class="muted">${escape(t("noVehicles"))}</p>`;
  const coords = new Intl.NumberFormat(locale, { maximumFractionDigits: 5, minimumFractionDigits: 5 });
  return (
    `<h2>${escape(t("vehicles", { n: units.length }))}</h2><ul class="units">` +
    units
      .map((u) => {
        const p = u.position;
        const where =
          p && p.latitude != null
            ? // Coordinates read left to right in every language.
              `<bdi dir="ltr" class="mono">${escape(coords.format(p.latitude))}, ${escape(coords.format(p.longitude))}</bdi>`
            : escape(t("neverReported"));
        const status = lookup(`status.${u.status}`) || u.status || "";
        return `<li>
          <button type="button" data-unit="${escape(u.id)}">
            <span class="units__name"><strong><bdi>${escape(u.name)}</bdi></strong>
              <span class="muted small" title="${escape(t("lastPosition"))}">${where}</span></span>
            <span class="badge">${escape(status)}</span>
          </button>
        </li>`;
      })
      .join("") +
    `</ul><p class="muted small">${escape(t("navigateHint"))}</p>`
  );
}

let bridge = null;

// Navigating the HOST, not this iframe: the customer stays in Zarokaa and
// lands on the vehicle they picked. An iframe that navigated itself would
// strand them inside a panel.
function bindUnits() {
  root.querySelectorAll("[data-unit]").forEach((button) => {
    button.addEventListener("click", () => {
      bridge.navigate({ path: `/unit/${encodeURIComponent(button.dataset.unit)}/view` });
      bridge.toast({ text: t("opening") });
    });
  });
}

async function main() {
  const params = new URLSearchParams(location.search);

  // First paint uses the query string (the server already set lang/dir/theme on
  // <html>). Anything security-relevant is in the signed session token, not here.
  applyLocale({ locale: params.get("locale") || html.lang || "en", dir: params.get("dir") || html.dir });
  show({ kind: "message", key: "connecting" });

  bridge = createApp({
    clientId: params.get("client_id") || undefined,
    // The host origin, so the bridge only ever talks to the page that framed us.
    host: params.get("host")
  });

  /**
   * Theme and locale are pushed, not polled. A customer switching to dark mode
   * or to Hebrew expects the panel to follow immediately; re-reading the query
   * string would only notice on a reload.
   */
  bridge.on("theme", (payload) => applyTheme({ theme: payload.theme || payload.mode, tokens: payload.tokens, font: payload.font }));
  bridge.on("locale", (payload) => {
    applyLocale(payload);
    show(view);
  });
  // Zarokaa tells the app when the customer's access has been suspended, so the
  // panel can say so instead of showing stale data or an unexplained error.
  bridge.on("suspended", ({ reason }) => show({ kind: "suspended", reason }));

  let context;
  try {
    context = await bridge.getContext();
  } catch (e) {
    show({ kind: "error", key: "hostUnreachable", vars: { error: e.message } });
    return;
  }
  applyTheme(context);
  applyLocale(context);
  show(view);

  bridge.loading(true);
  try {
    const token = await bridge.getSessionToken();

    const query = new URLSearchParams({ install_id: context.install_id || params.get("install_id") || "" });
    const installation = context.installation || params.get("installation");
    if (installation) query.set("installation", installation);
    const res = await fetch(`/api/units?${query.toString()}`, { headers: { "X-Polygon-Session": token } });
    const body = await res.json();

    if (!res.ok) {
      show({ kind: "error", text: body.error, key: "requestFailed", requestId: body.request_id });
      return;
    }
    show({ kind: "units", units: body.data || [] });
  } catch (e) {
    show({ kind: "error", text: e.message });
  } finally {
    bridge.loading(false);
  }
}

main();
