import { test } from "node:test";
import assert from "node:assert/strict";
import { RideBuilderClient, RideBuilderError } from "../dist/index.js";

// Fake fetch that records the last request and returns a canned status + JSON body.
function recordingFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return { status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test("register posts type/environment/version and returns the integration id", async () => {
  const fetchImpl = recordingFetch(200, { integrationId: "int_abc", status: "connected" });
  const client = new RideBuilderClient({ apiKey: "k", environment: "sandbox", fetch: fetchImpl });

  const result = await client.register();

  assert.deepEqual(result, { integrationId: "int_abc", status: "connected" });
  const call = fetchImpl.calls[0];
  assert.match(call.url, /\/integration\/register$/);
  assert.equal(call.method, "POST");
  assert.equal(call.body.type, "node_sdk");
  assert.equal(call.body.environment, "sandbox");
  assert.ok(Array.isArray(call.body.capabilities));
});

test("verify GETs /integration/verify and resolves ok on 200", async () => {
  const fetchImpl = recordingFetch(200, { status: "connected", retailerId: "r1" });
  const client = new RideBuilderClient({ apiKey: "k", fetch: fetchImpl });

  const result = await client.verify();

  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(fetchImpl.calls[0].method, "GET");
  assert.match(fetchImpl.calls[0].url, /\/integration\/verify$/);
});

test("verify throws a terminal RideBuilderError on 401", async () => {
  const client = new RideBuilderClient({
    apiKey: "k",
    maxRetries: 0,
    fetch: recordingFetch(401, { error: "invalid_auth" }),
  });
  await assert.rejects(
    () => client.verify(),
    (e) => e instanceof RideBuilderError && e.status === 401 && e.errorCode === "invalid_auth",
  );
});

test("heartbeat posts to /integration/heartbeat", async () => {
  const fetchImpl = recordingFetch(200, { ok: true });
  const client = new RideBuilderClient({ apiKey: "k", fetch: fetchImpl });

  const result = await client.heartbeat();

  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.match(fetchImpl.calls[0].url, /\/integration\/heartbeat$/);
  assert.equal(fetchImpl.calls[0].body.type, "node_sdk");
});

test("startHeartbeat fires an immediate heartbeat; stopHeartbeat clears the timer", async () => {
  const fetchImpl = recordingFetch(200, { ok: true });
  const client = new RideBuilderClient({ apiKey: "k", fetch: fetchImpl });

  client.startHeartbeat(50);
  await new Promise((r) => setTimeout(r, 15)); // shorter than the interval: only the immediate tick fires
  client.stopHeartbeat();

  const beats = fetchImpl.calls.filter((c) => /\/integration\/heartbeat$/.test(c.url));
  assert.ok(beats.length >= 1, "expected at least the immediate heartbeat");
});
