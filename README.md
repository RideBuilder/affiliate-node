# @ridebuilder/affiliate (Node/TS)

Server-side SDK for RideBuilder's FirstParty affiliate program. It does two things:

1. **Capture** the `click_id` a shopper arrives with, so your backend can bind it to the cart/order.
2. **Report** checkout and return postbacks to RideBuilder (auth, retries, idempotency handled).

This is the reference SDK — the .NET, PHP, and Java SDKs mirror the same shape.

## Install

```bash
npm install @ridebuilder/affiliate
```

Requires Node 18+ (uses the global `fetch`). Zero runtime dependencies.

## The pattern: capture at landing, bind to the order

The `click_id` only reliably reaches checkout if you take it out of the browser early and put it
on the cart/order. **Capture it and persist it in the same breath** — then send what you stored at
purchase.

```ts
import { capture, RideBuilderClient } from "@ridebuilder/affiliate";

// 1. Capture on every request, and bind it onto YOUR cart the moment it's seen. onCapture runs on
//    the request that carried it.
app.use(capture({
  onCapture: async (clickId, req) => {
    const cart = await carts.getOrCreate(req);
    cart.ridebuilderClickId = clickId;   // your storage — this is what survives to checkout
    await carts.save(cart);
  },
}));

// 2. At order time, send what you stored.
const rb = new RideBuilderClient({ apiKey: process.env.RIDEBUILDER_API_KEY! });

await rb.reportCheckout({
  orderId: order.id,
  subtotal: order.subtotal,   // major units, e.g. 199.99
  currency: "USD",
  clickId: order.ridebuilderClickId,
});
```

`capture()` resolves a validated click_id in the order attribution actually survives:

1. the **landing URL** (`?ref=ridebuilder&click_id=…`) — present only on the first hit,
2. a forwarded **`X-RideBuilder-Click-Id` header** — the decoupled-frontend path,
3. the **`ridebuilder_attribution` cookie** the browser snippet set — sent on every later request.

> **`req.ridebuilderClickId` lives for one request.** It holds what was resolved on *that* request; it
> is not a session store. Persist the value onto your own cart/order (as above) and read it back from
> there at checkout. Don't capture on the landing request and expect it to still be on `req` when the
> shopper adds to cart.

Store the API key server-side (env/secrets) — never in frontend code.

### Decoupled frontend (e.g. React) + separate Node backend

If your frontend is separate from your API, the landing request never hits your backend. The browser
**snippet** captures the `click_id` into a first-party cookie; get it to your backend one of two ways:

```ts
import { getClickIdFromCookieHeader, getClickIdFromHeaders } from "@ridebuilder/affiliate";

// Same registrable domain — the cookie rides along; read it off the Cookie header:
const clickId = getClickIdFromCookieHeader(req.headers.cookie);

// Cross-domain / mobile — the frontend forwards it on the checkout call:
const clickId = getClickIdFromHeaders(req.headers);   // default header: X-RideBuilder-Click-Id
```

Either way `reportCheckout` is unchanged. `capture()` already checks both, so if it is mounted you can
just read `req.ridebuilderClickId`.

### Refunds

```ts
await rb.reportReturn({
  returnId: refund.id,
  orderId: order.id,
  refundAmount: refund.amount,
  currency: "USD",
});
```

### Health check

`healthCheck()` sends an authenticated ping. It proves your API key is valid and active — even on
days with no orders — and lets RideBuilder record a heartbeat for your integration. Run it in your
deploy/CI as a self-test, and/or on a schedule (e.g. hourly).

```ts
await rb.healthCheck();          // resolves { ok: true, status: 200 }
// A bad/rotated key throws a terminal RideBuilderError with .errorCode "invalid_auth".
```

If RideBuilder stops seeing heartbeats from an integration that was previously reporting, it flags
the retailer as "gone dark" — so a broken key or a stopped integration is caught before you lose
commission, instead of failing silently.

### Integration protocol (register / verify / heartbeat)

For richer health tracking, an integration can announce itself and prove liveness over time. Pass
`environment` when constructing the client (`"production"` default, or `"sandbox"` for test traffic):

```ts
const rb = new RideBuilderClient({ apiKey: process.env.RIDEBUILDER_API_KEY!, environment: "production" });

// On install / app startup — the handshake. Idempotent; returns a stable integration id.
const { integrationId, status } = await rb.register();

// In deploy/CI — a self-test that throws on a bad/rotated key.
await rb.verify();

// On a schedule (e.g. hourly) — periodic liveness.
await rb.heartbeat();
```

On a **long-running server**, let the SDK send the periodic heartbeat for you (default hourly). Stop it
on shutdown:

```ts
rb.startHeartbeat();          // fires one now, then every hour (pass ms to override)
// ...on shutdown:
rb.stopHeartbeat();
```

The timer is unref'd, so it never keeps your process alive, and a failed ping is swallowed rather than
crashing your app. In **serverless** (no persistent process), skip `startHeartbeat()` and schedule
`heartbeat()` from an external cron instead — or rely on your normal postback traffic, which already
proves you're alive.

The SDK reports its own `type` (`node_sdk`), `version`, and default capabilities. `register()` and
`heartbeat()` are how RideBuilder distinguishes "integration alive" from "went dark" per integration —
`healthCheck()` remains available as a simple liveness ping.

## Capture options

- `capture({ property, onCapture })` — Express-style middleware. Resolves URL → forwarded header →
  attribution cookie. `property` renames the request field (default `ridebuilderClickId`);
  `onCapture(clickId, req)` runs when one is found — bind it to your cart/order there.
- `getClickIdFromUrl(url)` / `getClickIdFromQuery(query)` — framework-free landing capture.
- `getClickIdFromCookieHeader(cookieHeader)` — recover the click_id from the `ridebuilder_attribution`
  cookie the browser snippet set (the client-side path, for same-domain checkouts).
- `getClickIdFromHeaders(headers, name = CLICK_ID_HEADER)` — a forwarded header (case-insensitive;
  carries no `ref`, so only the click_id shape is checked).

All capture helpers validate `ref === "ridebuilder"` and the UUID-v4 `click_id`, returning `null`
otherwise — the same rules the browser snippet enforces. None of them persist anything; binding is
yours, and `req[property]` does not outlive the request.

## Client options

`new RideBuilderClient({ apiKey, baseUrl?, maxRetries?, timeoutMs?, fetch? })`

- `baseUrl` — defaults to `https://api.ridebuilder.com/v1`.
- `maxRetries` — retries on network errors, timeouts, 5xx, and 429 (default 3). Retries are safe:
  `order_id`/`return_id` are idempotency keys server-side, so nothing double-counts.
- `timeoutMs` — per-attempt timeout (default 10000).
- `fetch` — inject a custom fetch (for tests).

`reportCheckout` / `reportReturn` return `{ accepted, status }` (`202` = accepted). A `202` means
**received, not yet validated** — RideBuilder validates asynchronously. Invalid input throws a
non-retryable `RideBuilderError`; auth/size failures (`401`, `413`) throw with `.status` and
`.errorCode`.

## Contract

See the RideBuilder integration docs for the full REST contract this SDK wraps
(`/v1/postback/checkout`, `/v1/postback/return`, `/v1/postback/health`, the `/redirect` link format,
and API-key provisioning).
