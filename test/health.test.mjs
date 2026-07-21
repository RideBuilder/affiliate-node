import { test } from "node:test";
import assert from "node:assert/strict";
import { RideBuilderClient, RideBuilderError } from "../dist/index.js";

// A fake fetch that ignores the request and returns a canned status + JSON body.
const fakeFetch = (status, body) => async () => ({ status, json: async () => body });

test("healthCheck resolves { ok: true } on 200", async () => {
  const client = new RideBuilderClient({ apiKey: "k", fetch: fakeFetch(200, {}) });
  const result = await client.healthCheck();
  assert.deepEqual(result, { ok: true, status: 200 });
});

test("healthCheck throws a terminal RideBuilderError on 401", async () => {
  const client = new RideBuilderClient({
    apiKey: "k",
    fetch: fakeFetch(401, { error: "invalid_auth" }),
    maxRetries: 0,
  });
  await assert.rejects(
    () => client.healthCheck(),
    (e) => e instanceof RideBuilderError && e.status === 401 && e.errorCode === "invalid_auth",
  );
});
