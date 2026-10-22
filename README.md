# Fleet Snapshot — a Zarokaa marketplace app

A complete, runnable Zarokaa app in about 700 lines of plain Node, with **no
build step and no framework**. Clone it, run it, install it on a Zarokaa
account, and you have working examples of every part of the platform:

| | |
|---|---|
| **Install token** | RS256, verified against the issuing installation's JWKS and the hub directory before anything is provisioned — `src/installToken.js` |
| **OAuth 2.1 + PKCE (S256)** | authorize, exchange, and refresh with rotation handled correctly, per installation — `src/oauth.js`, `src/api.js` |
| **REST calls** | with pre-emptive token refresh and serialised refreshes — `src/api.js` |
| **Embedded UI** | in Zarokaa's iframe, through the Zarokaa app bridge — `public/embed.js` |
| **Webhooks** | signature verification on the raw body, dedup, replay-safe — `src/webhooks.js` |
| **Device commands** | send with an `Idempotency-Key`, the result by webhook or by polling with backoff, driver cards read from a Galileosky — `src/commands.js` |

Every file is commented with *why*, not just what. The bits that are easy to get
wrong say so in capitals.

You need a developer account and app credentials from the
[Zarokaa developer portal](https://developer.zarokaa.online). The
[guides](https://developer.zarokaa.online/docs/guides) explain each flow this app
implements, and the [API reference](https://developer.zarokaa.online/docs/reference)
lists every endpoint.

> **Two names you will see.** Zarokaa signs webhooks in an `X-Polygon-Signature`
> header and pushes its theme as `--polygon-*` CSS variables. Both are fixed parts
> of the platform's wire protocol; use them exactly as written.

---

## Try it in two minutes

```bash
git clone https://github.com/zarokaa/zarokaa-example-app
cd zarokaa-example-app
npm install
cp .env.example .env       # fill in the four values — see below
npm start
```

Then open <http://localhost:3000>. With no installation yet it prints the four
URLs you need to register the app.

Before you have credentials you can still run the self-test, which needs no
network and no Zarokaa:

```bash
npm test
```

It checks PKCE, install-token verification (unknown issuer, reused `jti`, wrong
audience, expiry, algorithm), webhook verification — including the one mistake
that catches nearly everybody (see *Webhooks* below) — and device-command
handling: one `Idempotency-Key` across retries, polling that stops at a final
status, and `unconfirmed` never reported as success.

---

## You need a public HTTPS URL

Zarokaa redirects a customer's **browser** to your install URL and **posts
webhooks** to your server. Neither can reach `localhost`, so for anything past
a first look you need a tunnel:

```bash
# any of these work
cloudflared tunnel --url http://localhost:3000
ngrok http 3000
```

Put the tunnel's HTTPS address in `.env` as `APP_BASE_URL`. The app warns at
startup if it is set to localhost.

### Serving HTTPS yourself (local review checks)

Without a tunnel (everything on one machine), the app can terminate TLS itself:
set `TLS_CERT_FILE` and `TLS_KEY_FILE` (both or neither; a self-signed pair is
fine) and `APP_BASE_URL=https://127.0.0.1:<PORT>`. Whatever calls you over a
self-signed cert (the hub's review worker, Zarokaa's webhook dispatcher) must
trust it, e.g. with `NODE_EXTRA_CA_CERTS=<cert>`; never disable certificate
verification instead.

```bash
mkdir -p data && openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
  -keyout data/tls.key -out data/tls.crt
```

## Configuration

`npm start` reads `./.env` (simple `KEY=value` lines, optional quotes); a
variable already set in the environment wins over the file. Missing required
values stop the app at boot; the rest print a warning.

| Variable | Required | Meaning |
|---|---|---|
| `APP_BASE_URL` | yes | Public base URL of this app. Install, redirect, embed and webhook URLs are built from it. |
| `ZAROKAA_CLIENT_ID` / `ZAROKAA_CLIENT_SECRET` | yes | From the portal. The secret is shown once; keep it in `.env` or a secrets manager, never in git. |
| `ZAROKAA_HUB_URL` | for real use | Hub origin. Install tokens are accepted only from issuers in `${ZAROKAA_HUB_URL}/api/registry/v1/directory`. Blank = single-installation dev mode. |
| `ZAROKAA_API_BASE` | dev mode | The one installation trusted when `ZAROKAA_HUB_URL` is blank, e.g. `https://demo.zarokaa.example.com/api/ext/v1`. Also the default for `APP_FRAME_ANCESTORS`. |
| `ZAROKAA_WEBHOOK_SECRET` | no | Signing secret of your webhook endpoint. Blank = every delivery is refused. |
| `PORT` | no | Default `3000`. |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | no | Serve HTTPS directly. Both or neither. |
| `APP_FRAME_ANCESTORS` | no | `frame-ancestors` sources sent on every page, space-separated. Default: the origin of `ZAROKAA_API_BASE`. `/embed` replaces it with the origin from `?host=`. |

**HSTS.** `Strict-Transport-Security: max-age=31536000` is sent on every
response the process serves over its own TLS listener. Behind a proxy or tunnel
that terminates TLS, Express sees plain HTTP and sends no HSTS, so add the
header at the proxy (or the `security_headers` review check warns).

**frame-ancestors.** Every page carries `Content-Security-Policy:
frame-ancestors <APP_FRAME_ANCESTORS>`, because the review checks fetch your app
URL without `?host=` and need a restrictive policy there. With a hub, set
`APP_FRAME_ANCESTORS` to every Zarokaa web origin you serve, space-separated;
`/embed` narrows it per request to the origin that is actually framing it.

## Register the app

In the developer portal, create an app and set:

| Field | Value |
|---|---|
| Install URL | `{APP_BASE_URL}/install` |
| Redirect URI | `{APP_BASE_URL}/oauth/callback` |
| App URL | `{APP_BASE_URL}/embed` |

Scopes: `units:read` is enough for the vehicle list. Ask only for what you use:

| Scope | What it unlocks here |
|---|---|
| `units:read` | the vehicle list; `unit.*` webhook topics |
| `webhooks:manage` | registering endpoints from the app itself; the `install.*` lifecycle topics |
| `devices:read` | `GET /devices`, to find a device id to send a command to |
| `devices.commands:execute` | sending commands, reading their results, and the `command.*` topics |
| `devices.commands:read` | reading command history and results without being able to send |

Copy the **client id** and **client secret** into `.env`. The secret is shown
once.

Then install the app on a Zarokaa account you own, or one that has invited you
as a tester. An unpublished app runs on real data for exactly those accounts.

## One app, many Zarokaa installations

Zarokaa runs as many separate deployments (ours and white-label partners'). Each
one is its own OAuth issuer with its own keys, install ids and tokens. This app
handles that:

1. Zarokaa sends the customer to `{APP_BASE_URL}/install?install_token=<JWT>`.
2. `src/installToken.js` accepts the token only if its `iss` (the installation's
   API base, e.g. `https://fleet.example.com/api`) is listed in the hub directory
   at `${ZAROKAA_HUB_URL}/api/registry/v1/directory` as an installation's
   `api_base` or one of its `api_bases` (white-label domains; cached 5 min), the RS256
   signature verifies against `${iss}/ext/v1/.well-known/jwks.json` (cached
   10 min per issuer), `aud` is your client id, it has not expired (5 minutes),
   and its `jti` has not been seen before. **Zarokaa does not track install-token
   use — rejecting a reused `jti` is your job.**
3. The installation is stored under `(installation, install_id)` together with
   `${iss}/ext/v1` as its API base. The authorize redirect, code exchange,
   refreshes and every REST call go to that installation, never to one global URL.
4. `/authorize` is a page in the Zarokaa web app (it needs the customer's
   session). Its URL comes from `${iss}/ext/v1/.well-known/oauth-authorization-server`
   → `authorization_endpoint`; `install_id` is required on it.
5. The embedded page keeps using the bridge's `?host=` origin for postMessage and
   `frame-ancestors`.

Without `ZAROKAA_HUB_URL` the app runs in single-installation dev mode: it trusts
exactly the issuer whose `${iss}/ext/v1` equals `ZAROKAA_API_BASE` and nothing
else.

## Webhooks

Register an endpoint pointed at `{APP_BASE_URL}/webhooks/zarokaa`, choose your
topics, and paste the signing secret it shows **once** into
`ZAROKAA_WEBHOOK_SECRET`.

`handle()` in `src/webhooks.js` understands `install.uninstalled`,
`install.scopes_updated`, `unit.created` / `unit.updated` / `unit.deleted`,
`unit.position`, `geofence.entered` / `geofence.exited`, and
`command.completed` / `command.failed` / `command.status_changed`. Anything else
is acknowledged and logged, never refused: topics are added within v1.

With that blank, this app refuses every delivery rather than accepting
unverified ones. That is deliberate.

### The mistake almost everyone makes

> Verifying the signature against `JSON.stringify(req.body)` instead of the raw
> bytes.

The re-serialised object has different key order and whitespace, so the HMAC
never matches and it looks like the platform is broken. This is why the webhook
route is mounted with `express.raw()` **before** `express.json()` — see the
comment at the top of `src/server.js`. There is a test for it in
`src/selftest.js` that fails loudly if anyone reorders those two lines.

Three more things worth knowing:

- **Delivery is at-least-once.** The same `id` arrives again after a retry whose
  `200` was lost, and on every replay through the installation's API. Deduplicate on it.
- **Answer fast, work after.** Zarokaa times out at 10 seconds and retries.
- **A rotation sends two `v1=` signatures.** Accept if *either* matches, or every
  secret rotation breaks you.

## Device commands

The demo page has a *Send a command* form: a device id (from `GET /devices`)
and a command code, `READ_CARDS` by default — Galileosky's "Read registered
cards". Sending never returns the result. The POST answers `queued` with a
`command_id`, and the device answers whenever it is online:

1. **Send** — `POST /devices/{device_id}/commands` with an `Idempotency-Key`.
   The key is made once per intention and rendered into the form, so a
   re-posted form (refresh, back, double click) returns the same `command_id`
   instead of sending the command twice. `src/commands.js` retries network
   errors, 429 and 5xx with that same key and never retries a 4xx.
2. **Webhook (preferred)** — exactly one `command.completed` or
   `command.failed` per command, once it is final, with the device's reply.
   For `READ_CARDS` the reply's `response.data.cards` is the list of
   `{ index, id }`; an empty list is `cards: []`.
3. **Poll (fallback)** — `/commands/<device>/<command>?wait=25` polls
   `GET /devices/{device_id}/commands/{command_id}` with capped exponential
   backoff and stops at the first final status (`terminal: true`).

**`unconfirmed` is not success.** It arrives on `command.completed` because
nothing visibly failed, but the device's protocol never confirms commands, so
nobody knows whether it ran. `outcome()` reports `confirmed: false` for it, and
the self-test fails if that ever changes. A reply the platform could not parse
is still `accepted`: read `response.raw` and `response.parse_error`.

The developer portal's guide "Send a command and track its result" has the
status table and which protocols confirm commands.

## Pass the review checks

Submitting a version runs seven automatic checks on the hub; the version goes
live the moment no blocking check fails. The developer portal's guide "Review
checks and publishing" has the exact conditions. For this app:

- [ ] `APP_BASE_URL` is a public HTTPS URL with a certificate the hub trusts;
      `/install` and `/embed` answer over it with any status below 500, and your
      privacy and support URLs answer below 400.
- [ ] `/embed` sends `frame-ancestors` without `?host=` (`APP_FRAME_ANCESTORS`),
      never `'none'`, `*` or `https:`, and that list covers every Zarokaa web
      origin you serve.
- [ ] `Strict-Transport-Security` reaches the hub on `/install` and `/embed`
      (own TLS listener, or added at your proxy). Warning only, but re-checked
      nightly.
- [ ] `/install` answers the hub's probe token with a 4xx, not a 5xx or a hang.
      This app rejects it (unknown issuer) with 400, which passes.
- [ ] The manifest: HTTPS URLs, exact redirect URI `{APP_BASE_URL}/oauth/callback`,
      known scopes (`alerts:*`, not the old `notifications:*`), a justification of
      at least 20 characters per scope, and `webhooks:manage` if you list
      lifecycle topics.
- [ ] The English listing has a tagline, description, privacy and support URLs,
      a data-retention statement and a screenshot.
- [ ] The submitter has a verified e-mail and two-factor authentication on.

After publishing, `https`, `frame_ancestors` and `security_headers` run again
every night; failures on three nights suspend the app on every installation.

## Refresh tokens rotate

Every refresh returns a **new** refresh token and invalidates the one you sent.
Presenting a rotated one is treated as theft: it revokes every token for that
installation and suspends it.

Two consequences this example handles, and most first integrations do not:

1. The new token is stored **before** the new access token is used
   (`store.saveTokens`).
2. Concurrent requests share one in-flight refresh (`refreshing` in
   `src/api.js`). Two workers refreshing at once is the classic way to suspend
   your own app.

---

## What is where

```
src/
  server.js     routes; the raw-body webhook mount is the first thing in it
  config.js     env, validated at boot with actionable warnings
  installToken.js  install-token verification: directory, JWKS, aud/exp, jti replay
  oauth.js      PKCE, discovery, code exchange, refresh — per installation
  api.js        API client: pre-emptive refresh, serialised, typed errors
  webhooks.js   signature verification and the event handlers
  commands.js   send with an Idempotency-Key, outcome of a command, poll with backoff
  store.js      installations keyed by (installation, install_id) — a JSON file, NOT a production store
  views.js      hand-written HTML, escaped at every call site
  selftest.js   30 checks, no network needed
public/
  embed.js      the iframe UI, over the Zarokaa app bridge
  app.css       follows the host's theme
vendor/
  app-bridge/   a checked-in copy of the SDK, so there is no build step
```

### Before you ship this shape

- `src/store.js` is a JSON file with plaintext refresh tokens. Use a database
  and encrypt them at rest.
- `handle()` in `src/webhooks.js` runs inline. Enqueue instead, and answer `200`
  immediately.
- There is no per-installation authorisation on `/api/units`. A real app
  authenticates the embedded page against the session token the bridge provides,
  rather than trusting the `install_id` in the query string.
- `/embed` echoes the `?host=` origin into `frame-ancestors` without checking it.
  A real app accepts only a host that is a directory `base_url` or the origin of
  one of an installation's `api_bases`, and otherwise falls back to the default
  list.
- After a suspension is lifted, refresh tokens are not reissued: a refresh
  answers `EXT_INVALID_TOKEN` while webhooks resume. Send a user through
  `/authorize` again with the same `install_id`.

## Deploy

Any Node host works — it is one process, no database, no build.

**Render / Railway / Fly** — build `npm install`, start `npm start`, and set the
environment variables from `.env.example`. Set `APP_BASE_URL` to the URL the
host gives you, then update the app's URLs in the developer portal to match.

**Docker**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

Whatever you deploy to, `data/` must be a writable volume or the installation
store is lost on restart — which in this example means the app forgets its
tokens. In a real app that is a database and the question does not arise.

## Licence

MIT — see [LICENSE](LICENSE). Use it as a starting point for your own app.
