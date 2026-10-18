import assert from "node:assert/strict";
import { test } from "node:test";
import { activateService } from "../src/service.mjs";

const config = { host: "127.0.0.1", port: 7420 };
const teardownPending = { error: "Bootstrap failed: 5: Input/output error", code: 5 };

function fixture({ bootout = "", bootstraps = [""], ready = true } = {}) {
  const calls = [];
  const waits = [];
  const requests = [];
  const messages = [];
  let bootstrapIndex = 0;
  return {
    calls, waits, requests, messages,
    options: {
      launch: async (...args) => {
        calls.push(args);
        if (args[0] === "bootout") return bootout;
        assert.equal(args[0], "bootstrap", "activation must not issue other launchd mutations");
        return bootstraps[Math.min(bootstrapIndex++, bootstraps.length - 1)];
      },
      wait: async (ms) => { waits.push(ms); },
      request: async (url, options) => {
        requests.push(url);
        assert.ok(options.signal instanceof AbortSignal, "health requests must remain bounded");
        return { ok: true, json: async () => ({ ready }) };
      },
      log: (message) => messages.push(message),
    },
  };
}

test("first service install tolerates an absent previous job and starts immediately", async () => {
  const f = fixture({ bootout: { error: "Could not find service", code: 3 } });
  await activateService(config, f.options);
  assert.deepEqual(f.calls.map(([action]) => action), ["bootout", "bootstrap"]);
  assert.deepEqual(f.waits, []);
  assert.deepEqual(f.requests, ["http://127.0.0.1:7420/api/health"]);
  assert.match(f.messages[0], /service running/);
});

test("service replacement retries transient bootstrap failure without booting out again", async () => {
  const f = fixture({ bootstraps: [teardownPending, teardownPending, ""] });
  await activateService(config, f.options);
  assert.deepEqual(f.calls.map(([action]) => action), ["bootout", "bootstrap", "bootstrap", "bootstrap"]);
  assert.equal(f.calls.filter(([action]) => action === "bootout").length, 1);
  assert.deepEqual(f.waits, [250, 500]);
  assert.equal(f.requests.length, 1, "probe readiness only after successful bootstrap");
});

test("persistent replacement failure has a bounded retry budget and preserves the error", async () => {
  const f = fixture({ bootstraps: [teardownPending] });
  await assert.rejects(activateService(config, f.options), /launchctl bootstrap failed: Bootstrap failed: 5: Input\/output error/);
  assert.equal(f.calls.filter(([action]) => action === "bootstrap").length, 5);
  assert.equal(f.calls.filter(([action]) => action === "bootout").length, 1);
  assert.deepEqual(f.waits, [250, 500, 1000, 2000]);
  assert.equal(f.requests.length, 0);
  assert.equal(f.messages.length, 0);
});

test("first-install and non-transient failures are not retried or undone", async () => {
  for (const options of [
    { bootout: { error: "Could not find service", code: 3 }, bootstraps: [teardownPending] },
    { bootstraps: [{ error: "Invalid property list", code: 78 }] },
    { bootstraps: [{ error: "launchctl unavailable", code: "ENOENT" }] },
  ]) {
    const f = fixture(options);
    await assert.rejects(activateService(config, f.options), /launchctl bootstrap failed:/);
    assert.deepEqual(f.calls.map(([action]) => action), ["bootout", "bootstrap"]);
    assert.deepEqual(f.waits, []);
    assert.equal(f.requests.length, 0);
  }
});

test("service readiness and its running message use the configured loopback address", async () => {
  for (const [host, address] of [["::1", "[::1]"], ["localhost", "localhost"]]) {
    const f = fixture();
    await activateService({ ...config, host, port: 7461 }, f.options);
    assert.deepEqual(f.requests, [`http://${address}:7461/api/health`]);
    assert.ok(f.messages[0].includes(`http://${address}:7461`));
  }
});

test("a bootstrapped service with unavailable health reports the bounded readiness timeout", async () => {
  const f = fixture({ ready: false });
  await activateService(config, f.options);
  assert.equal(f.requests.length, 40);
  assert.deepEqual(f.waits, Array(40).fill(500));
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /dashboard did not answer yet/);
});
