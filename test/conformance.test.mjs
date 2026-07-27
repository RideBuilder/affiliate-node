import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RideBuilderClient, RideBuilderError } from "../dist/index.js";

// Runs the shared, language-neutral fixtures in sdk/conformance/*.json against the Node client — the same
// cases the .NET SDK runs — so both encode byte-for-byte the same wire contract.

const CONFORMANCE_DIR = new URL("../../conformance/", import.meta.url);

function loadCases() {
  const dir = fileURLToPath(CONFORMANCE_DIR);
  const cases = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(new URL(file, CONFORMANCE_DIR), "utf8"));
    for (const c of parsed) cases.push(c);
  }
  return cases;
}

function recordingFetch(responses) {
  const queue = [...responses];
  const calls = [];
  const fn = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const r = queue.length > 0 ? queue.shift() : responses[responses.length - 1];
    return { status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

function buildResponses(c) {
  if (c.responses) return c.responses;
  if (c.response) return [c.response];
  return [{ status: 200 }];
}

function buildClient(c, fetchImpl) {
  const cfg = c.client;
  return new RideBuilderClient({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    maxRetries: cfg.maxRetries ?? 3,
    environment: cfg.environment,
    fetch: fetchImpl,
  });
}

function invoke(client, call, args) {
  switch (call) {
    case "reportCheckout":
      return client.reportCheckout({
        orderId: args.orderId,
        subtotal: args.subtotal,
        currency: args.currency,
        clickId: args.clickId,
      });
    case "reportReturn":
      return client.reportReturn({
        returnId: args.returnId,
        orderId: args.orderId,
        refundAmount: args.refundAmount,
        currency: args.currency,
      });
    case "healthCheck":
      return client.healthCheck();
    case "register":
      return client.register();
    case "verify":
      return client.verify();
    case "heartbeat":
      return client.heartbeat();
    default:
      throw new Error(`unknown call: ${call}`);
  }
}

// Deep match: numbers by value; a string wrapped in <angle brackets> is a wildcard requiring any non-empty
// string; objects must have the same key set.
function deepMatch(expected, actual) {
  if (typeof expected === "string" && /^<.*>$/.test(expected)) {
    return typeof actual === "string" && actual.length > 0;
  }
  if (expected === null) return actual === null;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((e, i) => deepMatch(e, actual[i]));
  }
  if (typeof expected === "object") {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
    const ek = Object.keys(expected);
    const ak = Object.keys(actual);
    if (ek.length !== ak.length) return false;
    return ek.every((k) => k in actual && deepMatch(expected[k], actual[k]));
  }
  return expected === actual;
}

function findHeader(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function assertRequest(expected, calls, name) {
  assert.ok(calls.length > 0, `${name}: expected at least one request`);
  const call = calls[0];
  if (expected.method) assert.equal(call.method, expected.method, `${name}: method`);
  if (expected.path) assert.ok(call.url.endsWith(expected.path), `${name}: path ${call.url}`);
  if (expected.headers) {
    for (const [k, v] of Object.entries(expected.headers)) {
      assert.equal(findHeader(call.headers, k), v, `${name}: header ${k}`);
    }
  }
  if (expected.body) {
    assert.ok(deepMatch(expected.body, call.body), `${name}: body ${JSON.stringify(call.body)}`);
  }
}

for (const c of loadCases()) {
  test(`conformance: ${c.name}`, async () => {
    const fetchImpl = recordingFetch(buildResponses(c));
    const client = buildClient(c, fetchImpl);
    const expect = c.expect;

    let result;
    let error;
    try {
      result = await invoke(client, c.call, c.args);
    } catch (e) {
      error = e;
    }

    if (expect.argError) {
      assert.ok(error, `${c.name}: expected the call to throw`);
      if (expect.requestCount !== undefined) assert.equal(fetchImpl.calls.length, expect.requestCount, `${c.name}: requestCount`);
      return;
    }

    if (expect.request) assertRequest(expect.request, fetchImpl.calls, c.name);
    if (expect.requestCount !== undefined) assert.equal(fetchImpl.calls.length, expect.requestCount, `${c.name}: requestCount`);

    if (expect.error) {
      assert.ok(error instanceof RideBuilderError, `${c.name}: expected a RideBuilderError, got ${error}`);
      if (expect.error.retryable !== undefined) assert.equal(error.retryable, expect.error.retryable, `${c.name}: retryable`);
      if (expect.error.status !== undefined) assert.equal(error.status, expect.error.status, `${c.name}: status`);
      if (expect.error.errorCode !== undefined) assert.equal(error.errorCode, expect.error.errorCode, `${c.name}: errorCode`);
      return;
    }

    assert.ok(!error, `${c.name}: unexpected error ${error?.message}`);
    if (expect.result) assert.ok(deepMatch(expect.result, result), `${c.name}: result ${JSON.stringify(result)}`);
  });
}
