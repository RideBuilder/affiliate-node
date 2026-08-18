import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  capture,
  getClickIdFromHeaders,
  getClickIdFromCookieHeader,
  CLICK_ID_HEADER,
} from "../dist/index.js";

const CLICK_ID = "1e8e6c0a-1111-4111-8111-111111111111";

const attributionCookie = (clickId) =>
  "ridebuilder_attribution=" +
  encodeURIComponent(JSON.stringify({ click_id: clickId, ref: "ridebuilder" }));

const run = (middleware, req) =>
  new Promise((resolve) => middleware(req, {}, () => resolve(req)));

test("getClickIdFromHeaders reads the forwarded header", () => {
  assert.equal(getClickIdFromHeaders({ [CLICK_ID_HEADER]: CLICK_ID }), CLICK_ID);
});

test("getClickIdFromHeaders matches the header name case-insensitively", () => {
  assert.equal(getClickIdFromHeaders({ "x-ridebuilder-click-id": CLICK_ID }), CLICK_ID);
});

test("getClickIdFromHeaders takes the first value of a repeated header", () => {
  assert.equal(getClickIdFromHeaders({ "x-ridebuilder-click-id": [CLICK_ID, "other"] }), CLICK_ID);
});

test("getClickIdFromHeaders honours a custom header name", () => {
  assert.equal(getClickIdFromHeaders({ "x-shop-click": CLICK_ID }, "X-Shop-Click"), CLICK_ID);
});

test("getClickIdFromHeaders returns null for an invalid click_id", () => {
  assert.equal(getClickIdFromHeaders({ [CLICK_ID_HEADER]: "not-a-uuid" }), null);
});

test("capture stashes the click_id from the landing url", async () => {
  const req = await run(capture(), {
    url: `/product?ref=ridebuilder&click_id=${CLICK_ID}`,
    headers: {},
  });
  assert.equal(req.ridebuilderClickId, CLICK_ID);
});

// The regression this suite used to miss: req[property] lives for ONE request, and only the landing hit
// carries the click_id in its URL. A shopper who lands and then adds to cart must still resolve, off the
// cookie the browser keeps sending — otherwise attribution is lost on every request after the first.
test("capture still resolves on a later request with no query", async () => {
  const middleware = capture();

  const landing = await run(middleware, {
    url: `/product?ref=ridebuilder&click_id=${CLICK_ID}`,
    headers: {},
  });
  assert.equal(landing.ridebuilderClickId, CLICK_ID);

  const addToCart = await run(middleware, {
    url: "/cart/add",
    headers: { cookie: attributionCookie(CLICK_ID) },
  });
  assert.equal(addToCart.ridebuilderClickId, CLICK_ID);
});

test("capture resolves from a forwarded header", async () => {
  const req = await run(capture(), {
    url: "/api/checkout",
    headers: { "x-ridebuilder-click-id": CLICK_ID },
  });
  assert.equal(req.ridebuilderClickId, CLICK_ID);
});

test("capture prefers the landing url over a stale cookie", async () => {
  const fresh = "2f9f7d1b-2222-4222-9222-222222222222";
  const req = await run(capture(), {
    url: `/product?ref=ridebuilder&click_id=${fresh}`,
    headers: { cookie: attributionCookie(CLICK_ID) },
  });
  assert.equal(req.ridebuilderClickId, fresh);
});

test("capture ignores a malformed cookie", async () => {
  const req = await run(capture(), {
    url: "/cart/add",
    headers: { cookie: "ridebuilder_attribution=not-json" },
  });
  assert.equal(req.ridebuilderClickId, undefined);
});

test("capture leaves the request alone when nothing carries a click_id", async () => {
  const req = await run(capture(), { url: "/cart/add", headers: {} });
  assert.equal(req.ridebuilderClickId, undefined);
});

test("getClickIdFromCookieHeader still reads the snippet cookie directly", () => {
  assert.equal(getClickIdFromCookieHeader(attributionCookie(CLICK_ID)), CLICK_ID);
});

// The wire `version` is what the backend records for this integration. These drifted once (package
// 0.4.1 reported 0.4.0 on every register/heartbeat); this guard is why that cannot ship silently again.
test("the reported SDK version matches package.json", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  let sent;
  const { RideBuilderClient } = await import("../dist/index.js");
  const client = new RideBuilderClient({
    apiKey: "k",
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return { status: 200, json: async () => ({ ok: true }) };
    },
  });
  await client.heartbeat();

  assert.equal(sent.version, pkg.version);
});
