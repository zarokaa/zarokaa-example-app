"use strict";

/**
 * HTML, written by hand.
 *
 * NO TEMPLATE ENGINE AND NO BUILD STEP, on purpose. This example exists to be
 * read: a developer should be able to open any file and see exactly what is
 * sent, without first learning which templating dialect it uses. The cost is
 * that everything interpolated has to be escaped, which `esc` below does and
 * every call site uses.
 */

function esc(value) {
  return String(value === null || value === undefined ? "" : value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// First-paint presentation from the iframe URL; the bridge corrects it after the handshake.
function presentation(query = {}) {
  const lang = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(query.locale || "")) ? query.locale : "en";
  return { lang, dir: query.dir === "rtl" ? "rtl" : "ltr", theme: query.theme === "dark" ? "dark" : "light" };
}

function page(title, body, { embedded = false, lang = "en", dir = "ltr", theme = "light" } = {}) {
  return `<!doctype html>
<html lang="${esc(lang)}" dir="${esc(dir)}" data-theme="${esc(theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body class="${embedded ? "embedded" : ""}">
${embedded ? "" : `<header class="bar"><strong>Fleet Snapshot</strong><span class="muted">Zarokaa example app</span></header>`}
<main>${body}</main>
</body>
</html>`;
}

function notice(kind, text) {
  return `<div class="notice notice--${esc(kind)}">${text}</div>`;
}

function unitsTable(units) {
  if (!units.length) {
    return `<p class="muted">No vehicles returned. The installation may have no vehicles allocated, or the scope was not granted.</p>`;
  }
  const rows = units
    .map(
      (u) => `<tr>
      <td><strong>${esc(u.name)}</strong><div class="muted small">${esc(u.id)}</div></td>
      <td>${esc(u.status || "")}</td>
      <td class="mono">${
        u.position && u.position.latitude !== null && u.position.latitude !== undefined
          ? `${esc(u.position.latitude)}, ${esc(u.position.longitude)}`
          : '<span class="muted">never reported</span>'
      }</td>
      <td>${esc((u.driver && u.driver.name) || "")}</td>
    </tr>`
    )
    .join("");
  return `<table>
    <thead><tr><th>Vehicle</th><th>Status</th><th>Last position</th><th>Driver</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function deliveriesTable(deliveries) {
  if (!deliveries.length) {
    return `<p class="muted">Nothing yet. Register a webhook endpoint and make something happen in Zarokaa.</p>`;
  }
  return `<table>
    <thead><tr><th>When</th><th>Topic</th><th>Result</th></tr></thead>
    <tbody>${deliveries
      .map(
        (d) => `<tr>
        <td class="muted small mono">${esc(d.at)}</td>
        <td class="mono">${esc(d.topic)}</td>
        <td>${d.ok ? esc(d.result) : `<span class="bad">${esc(d.result)}</span>`}</td>
      </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

module.exports = { esc, page, presentation, notice, unitsTable, deliveriesTable };
