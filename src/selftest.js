"use strict";

/**
 * A self-test for the parts that are easy to get wrong and silent when wrong.
 *
 * NOT A UNIT TEST SUITE. It covers exactly the things that, in the author's
 * experience, every first integration gets wrong and then blames the platform
 * for: PKCE, install-token verification (issuer trust, audience, replay),
 * webhook verification against a re-serialised body, and device-command
 * outcomes (unconfirmed is not success; one Idempotency-Key across retries).
 * It needs no network, no credentials and no
 * Zarokaa — `npm test` runs it in under a second.
 */

process.env.APP_BASE_URL = process.env.APP_BASE_URL || "https://example.test";
process.env.ZAROKAA_CLIENT_ID = process.env.ZAROKAA_CLIENT_ID || "pgc_selftest";
process.env.ZAROKAA_CLIENT_SECRET = process.env.ZAROKAA_CLIENT_SECRET || "pgs_selftest_secret";
process.env.ZAROKAA_WEBHOOK_SECRET = process.env.ZAROKAA_WEBHOOK_SECRET || "whsec_selftest";

const assert = require("assert");
const crypto = require("crypto");

const oauth = require("./oauth");
const webhooks = require("./webhooks");
const commands = require("./commands");
const store = require("./store");
const { config } = require("./config");
const { createInstallTokenVerifier } = require("./installToken");

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

console.log("\nzarokaa-example-app self-test\n");

/* --- PKCE ----------------------------------------------------------------- */

test("PKCE verifier is long enough that the challenge cannot be brute-forced", () => {
  const verifier = oauth.createVerifier();
  assert.ok(verifier.length >= 43, `verifier is ${verifier.length} chars, RFC 7636 requires 43-128`);
  assert.ok(/^[A-Za-z0-9._~-]+$/.test(verifier), "verifier must be unreserved characters only");
});

test("PKCE challenge is S256 of the verifier, base64url, unpadded", () => {
  const verifier = "a".repeat(43);
  const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
  assert.strictEqual(oauth.challengeFor(verifier), expected);
  assert.ok(!oauth.challengeFor(verifier).includes("="), "base64url must not be padded");
});

/* --- the install token ---------------------------------------------------- */

// A fake Zarokaa installation and a fake attacker, each with its own RSA key and JWKS.
function fakeIssuer(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] },
    sign(claims, header = { alg: "RS256", typ: "JWT", kid }) {
      const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(
        JSON.stringify(claims)
      ).toString("base64url")}`;
      return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
    }
  };
}

const ZAROKAA = fakeIssuer("zarokaa-1");
const ATTACKER = fakeIssuer("zarokaa-1");
const ISS = "https://zarokaa.test/api";
const HUB = "https://hub.test";

function fakeFetch(url) {
  const documents = {
    [`${HUB}/api/registry/v1/directory`]: { data: [{ code: "kindgps-in", api_base: ISS }] },
    [`${ISS}/ext/v1/.well-known/jwks.json`]: ZAROKAA.jwks,
    ["https://evil.test/api/ext/v1/.well-known/jwks.json"]: ATTACKER.jwks
  };
  const body = documents[url];
  return Promise.resolve({ ok: !!body, status: body ? 200 : 404, json: async () => body });
}

function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISS,
    aud: config.clientId,
    installation: "kindgps-in",
    install_id: "inst-1",
    account_id: "acct-1",
    scope_mode: "account",
    handle: "fleet-snapshot",
    token_use: "install",
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 300,
    ...overrides
  };
}

const hubVerifier = () => createInstallTokenVerifier({ clientId: config.clientId, hubUrl: HUB, fetchImpl: fakeFetch });

test("a valid install token from a directory-listed installation is accepted", async () => {
  const result = await hubVerifier().verify(ZAROKAA.sign(claims()));
  assert.ok(result.ok, result.reason);
  assert.strictEqual(result.apiBase, "https://zarokaa.test/api/ext/v1");
  assert.strictEqual(result.installation, "kindgps-in");
});

test("a token from an issuer that is not in the hub directory is refused, even if it verifies against its own JWKS", async () => {
  const result = await hubVerifier().verify(ATTACKER.sign(claims({ iss: "https://evil.test/api" })));
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /not a known Zarokaa installation/);
});

test("an attacker's key presented under a trusted issuer is refused", async () => {
  const result = await hubVerifier().verify(ATTACKER.sign(claims()));
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /signature/);
});

test("a reused jti is refused, so a captured install link works once", async () => {
  const verifier = hubVerifier();
  const token = ZAROKAA.sign(claims());
  assert.ok((await verifier.verify(token)).ok, "first use should pass");
  const again = await verifier.verify(token);
  assert.strictEqual(again.ok, false);
  assert.match(again.reason, /already been used/);
});

test("a token issued for another app (aud) is refused", async () => {
  const result = await hubVerifier().verify(ZAROKAA.sign(claims({ aud: "pgc_someone_else" })));
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /not issued for this app/);
});

test("an expired install token is refused", async () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  const result = await hubVerifier().verify(ZAROKAA.sign(claims({ iat: past - 300, exp: past })));
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /expired/);
});

test("the algorithm is asserted, never taken from the header", async () => {
  const result = await hubVerifier().verify(ZAROKAA.sign(claims(), { alg: "none", kid: "zarokaa-1" }));
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /algorithm/);
});

test("without ZAROKAA_HUB_URL only ZAROKAA_API_BASE is trusted (single-installation dev mode)", async () => {
  const dev = createInstallTokenVerifier({
    clientId: config.clientId,
    apiBase: `${ISS}/ext/v1`,
    fetchImpl: fakeFetch
  });
  assert.ok((await dev.verify(ZAROKAA.sign(claims()))).ok, "the configured deployment should pass");
  const other = await dev.verify(ATTACKER.sign(claims({ iss: "https://evil.test/api" })));
  assert.strictEqual(other.ok, false);
});

/* --- webhook signatures --------------------------------------------------- */

const SECRET = process.env.ZAROKAA_WEBHOOK_SECRET;

function signWebhook(rawBody, secret = SECRET, at = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac("sha256", secret).update(`${at}.${rawBody}`).digest("hex");
  return `t=${at},v1=${mac}`;
}

const BODY = JSON.stringify({
  id: "evt_selftest",
  topic: "unit.created",
  occurred_at: "2026-08-30T09:14:22.481Z",
  data: { unit_id: "u1", name: "Truck 7" }
});

test("a correctly signed webhook verifies", () => {
  const result = webhooks.verify(Buffer.from(BODY), signWebhook(BODY));
  assert.ok(result.ok, result.reason);
});

/**
 * The regression that matters most in this whole file. Verifying against
 * `JSON.stringify(req.body)` instead of the raw bytes is the most common
 * integration bug on any webhook platform, and it fails silently — the
 * signature simply never matches.
 */
test("verifying against a RE-SERIALISED body fails, which is why express.raw() is used", () => {
  const header = signWebhook(BODY);
  const reserialised = JSON.stringify(JSON.parse(BODY), null, 2); // same data, different bytes
  assert.strictEqual(webhooks.verify(Buffer.from(reserialised), header).ok, false);
  // ...and the original bytes still pass, proving the header itself was fine.
  assert.strictEqual(webhooks.verify(Buffer.from(BODY), header).ok, true);
});

test("a body changed by one byte fails", () => {
  const header = signWebhook(BODY);
  assert.strictEqual(webhooks.verify(Buffer.from(BODY + " "), header).ok, false);
});

test("an old timestamp fails, so a captured delivery cannot be replayed forever", () => {
  const header = signWebhook(BODY, SECRET, Math.floor(Date.now() / 1000) - 3600);
  const result = webhooks.verify(Buffer.from(BODY), header);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /window/);
});

test("during a secret rotation EITHER signature is accepted", () => {
  // Zarokaa signs with the new and the old secret and sends both, so an app
  // that has not yet deployed the new secret keeps verifying.
  const at = Math.floor(Date.now() / 1000);
  const mine = crypto.createHmac("sha256", SECRET).update(`${at}.${BODY}`).digest("hex");
  const theirs = crypto.createHmac("sha256", "whsec_rotated").update(`${at}.${BODY}`).digest("hex");
  const header = `t=${at},v1=${theirs},v1=${mine}`;
  assert.ok(webhooks.verify(Buffer.from(BODY), header).ok, "the second v1 must be tried too");
});

test("no configured secret means every delivery is refused, never accepted unverified", () => {
  const result = webhooks.verify(Buffer.from(BODY), signWebhook(BODY), "");
  assert.strictEqual(result.ok, false);
});

/* --- deduplication -------------------------------------------------------- */

test("the same event id is only processed once", () => {
  const id = `evt_${Date.now()}`;
  assert.strictEqual(store.firstTimeSeeing(id), true);
  assert.strictEqual(store.firstTimeSeeing(id), false, "delivery is at-least-once — dedupe on id");
});

/* --- CSRF state ----------------------------------------------------------- */

test("an OAuth state is single-use", () => {
  store.putPending("state-1", { verifier: "v" });
  assert.ok(store.takePending("state-1"), "first read should succeed");
  assert.strictEqual(store.takePending("state-1"), null, "a replayable state is not a CSRF defence");
});

/* --- device commands ------------------------------------------------------ */

const READ_CARDS_ACCEPTED = {
  command_id: "cmd-1",
  device_id: "dev-1",
  command: { code: "READ_CARDS", label: "Read registered cards" },
  status: "accepted",
  terminal: true,
  status_reason: null,
  response: {
    raw: "IBUTTONS:0091022C,0,0,0,0,0,0,0",
    encoding: "text",
    parser: null,
    data: null,
    parse_error: null,
    truncated: false
  }
};

test("command: an accepted command carries the device's reply text as sent", () => {
  const o = commands.outcome(READ_CARDS_ACCEPTED);
  assert.strictEqual(o.confirmed, true);
  assert.strictEqual(o.raw, "IBUTTONS:0091022C,0,0,0,0,0,0,0");
  assert.strictEqual(o.encoding, "text");
  assert.match(commands.describe(READ_CARDS_ACCEPTED), /accepted: IBUTTONS:0091022C/);
});

test("command: unconfirmed is final but NEVER reported as confirmed", () => {
  const c = { command_id: "cmd-2", status: "unconfirmed", terminal: true, response: null };
  const o = commands.outcome(c);
  assert.strictEqual(o.final, true);
  assert.strictEqual(o.confirmed, false);
  assert.strictEqual(o.failed, false);
  assert.match(commands.describe(c), /may or may not have run/);
});

test("command: failed statuses carry the reason", () => {
  const c = { command_id: "cmd-3", status: "timeout", terminal: true, status_reason: { code: "ack_timeout", text: "no reply in 120 s" } };
  const o = commands.outcome(c);
  assert.strictEqual(o.failed, true);
  assert.deepStrictEqual(o.reason, { code: "ack_timeout", text: "no reply in 120 s" });
  assert.match(commands.describe(c), /timeout \(ack_timeout: no reply in 120 s\)/);
});

test("command: a binary reply stays hex and is still accepted", () => {
  const c = { command_id: "cmd-4", status: "accepted", terminal: true, response: { raw: "0A1BFF", encoding: "hex" } };
  const o = commands.outcome(c);
  assert.strictEqual(o.confirmed, true);
  assert.strictEqual(o.encoding, "hex");
  assert.match(commands.describe(c), /accepted: 0A1BFF/);
});

test("command: queued and sent are in flight; the six others are final", () => {
  for (const s of ["queued", "sent"]) assert.strictEqual(commands.isTerminal({ status: s }), false, s);
  for (const s of ["accepted", "rejected", "unconfirmed", "timeout", "expired", "failed"]) {
    assert.strictEqual(commands.isTerminal({ status: s }), true, s);
  }
  assert.strictEqual(commands.isTerminal({ status: "sent", terminal: true }), true, "the API's terminal flag wins");
});

test("command: backoff doubles and is capped", () => {
  const mid = () => 0.5; // no jitter
  assert.strictEqual(commands.backoffMs(0, { random: mid }), 2000);
  assert.strictEqual(commands.backoffMs(3, { random: mid }), 16000);
  assert.strictEqual(commands.backoffMs(20, { random: mid }), 60000);
});

test("command: a retried send reuses ONE Idempotency-Key, so it cannot run twice", async () => {
  const keys = [];
  let calls = 0;
  const fakeCall = async (key, path, opts) => {
    keys.push(opts.idempotencyKey);
    assert.strictEqual(opts.method, "POST");
    assert.strictEqual(path, "/devices/dev-1/commands");
    assert.deepStrictEqual(opts.body, { command: "READ_CARDS" });
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("socket hang up"), { status: undefined }); // network error
    if (calls === 2) throw Object.assign(new Error("busy"), { status: 503, retryable: true });
    return { data: { command_id: "cmd-1", status: "queued", created_at: "2026-10-21T10:15:00Z" } };
  };
  const sent = await commands.send(fakeCall, "inst", "dev-1", { command: "READ_CARDS", sleep: async () => {} });
  assert.strictEqual(sent.command_id, "cmd-1");
  assert.strictEqual(keys.length, 3);
  assert.ok(keys.every((k) => k === keys[0]) && /^[A-Za-z0-9._:-]{8,255}$/.test(keys[0]), "same, valid key on every attempt");
});

test("command: a 4xx is not retried", async () => {
  let calls = 0;
  const fakeCall = async () => {
    calls += 1;
    throw Object.assign(new Error("not found"), { status: 404, code: "EXT_NOT_FOUND", retryable: false });
  };
  await assert.rejects(commands.send(fakeCall, "inst", "dev-x", { command: "READ_CARDS", sleep: async () => {} }), /not found/);
  assert.strictEqual(calls, 1);
});

test("command: polling stops at the first final status", async () => {
  const seq = [{ status: "queued" }, { status: "sent" }, { ...READ_CARDS_ACCEPTED }, { status: "should-not-read" }];
  let reads = 0;
  let clock = 0;
  const result = await commands.waitForResult(async () => seq[reads++], {
    budgetMs: 10 * 60_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    random: () => 0.5
  });
  assert.strictEqual(result.done, true);
  assert.strictEqual(reads, 3);
  assert.strictEqual(result.command.status, "accepted");
});

test("command: polling gives up at the budget and hands back the last in-flight record", async () => {
  let clock = 0;
  const result = await commands.waitForResult(async () => ({ status: "queued" }), {
    budgetMs: 60_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    random: () => 0.5
  });
  assert.strictEqual(result.done, false);
  assert.strictEqual(result.command.status, "queued");
  assert.ok(clock <= 60_000, "never sleeps past the budget");
});

test("command: command.completed and command.failed webhooks are described, unconfirmed included", () => {
  assert.match(webhooks.handle({ topic: "command.completed", data: READ_CARDS_ACCEPTED }), /accepted: IBUTTONS:0091022C/);
  assert.match(
    webhooks.handle({ topic: "command.failed", data: { command_id: "c", status: "rejected", status_reason: { code: "device_rejected", text: "WRONG PARAM" } } }),
    /rejected \(device_rejected: WRONG PARAM\)/
  );
  assert.match(webhooks.handle({ topic: "command.completed", data: { command_id: "c", status: "unconfirmed" } }), /may or may not/);
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok   ${name}`);
    } catch (e) {
      console.error(`  FAIL ${name}\n       ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}\n`);
})();
