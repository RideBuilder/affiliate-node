import {
  COOKIE_NAME,
  REF_VALUE,
  isValidClickId,
  parseAttributionCookie,
  parseCookieHeader,
} from "./validation.js";

// --- landing capture: read click_id straight from the request URL ---

export function getClickIdFromSearchParams(params: URLSearchParams): string | null {
  if (params.get("ref") !== REF_VALUE) return null;
  const clickId = params.get("click_id");
  return isValidClickId(clickId) ? clickId : null;
}

export function getClickIdFromUrl(url: string | URL): string | null {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    try {
      parsed = new URL(String(url), "http://placeholder.local");
    } catch {
      return null;
    }
  }
  return getClickIdFromSearchParams(parsed.searchParams);
}

export function getClickIdFromQuery(query: Record<string, unknown>): string | null {
  if (query.ref !== REF_VALUE) return null;
  const clickId = query.click_id;
  return isValidClickId(clickId) ? clickId : null;
}

// --- checkout read: recover click_id from the attribution cookie (client-side path) ---

export function getClickIdFromCookieHeader(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const raw = parseCookieHeader(cookieHeader)[COOKIE_NAME];
  if (!raw) return null;
  const attribution = parseAttributionCookie(raw);
  return attribution ? attribution.click_id : null;
}

export const CLICK_ID_HEADER = "X-RideBuilder-Click-Id";

// Read a validated click_id off a forwarding header (case-insensitive; default X-RideBuilder-Click-Id) —
// the decoupled path, where a separate frontend forwards it on the checkout call. A forwarded header
// carries no `ref`, so only the click_id shape is enforced.
export function getClickIdFromHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string = CLICK_ID_HEADER,
): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== target) continue;
    const raw = headers[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return isValidClickId(value) ? value : null;
  }
  return null;
}

// --- optional Express-style middleware ---

interface CaptureRequestLike {
  url?: string;
  originalUrl?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

export interface CaptureOptions {
  property?: string;
  onCapture?: (clickId: string, req: CaptureRequestLike) => void | Promise<void>;
}

// Reads click_id off the incoming request and stashes it on req[property] (default `ridebuilderClickId`).
// Resolves in the order attribution survives: the landing URL, then a forwarded X-RideBuilder-Click-Id
// header, then the `ridebuilder_attribution` cookie the browser snippet set — so a returning shopper is
// re-hydrated on requests whose URL carries nothing.
//
// req[property] lives for ONE request. Bind the click_id onto your cart/order from onCapture (or read
// req[property] during the same request); do NOT capture on the landing hit and expect it to still be
// there when the shopper adds to cart. Send the value stored on your own order at checkout.
export function capture(options: CaptureOptions = {}) {
  const property = options.property ?? "ridebuilderClickId";
  return function ridebuilderCapture(
    req: CaptureRequestLike,
    _res: unknown,
    next: () => void,
  ): void {
    let clickId: string | null = null;
    if (req.query && Object.keys(req.query).length > 0) {
      clickId = getClickIdFromQuery(req.query);
    }
    if (!clickId) {
      const raw = req.originalUrl ?? req.url;
      if (raw) clickId = getClickIdFromUrl(raw);
    }
    if (!clickId) {
      clickId = getClickIdFromHeaders(req.headers);
    }
    if (!clickId) {
      const cookieHeader = req.headers?.cookie;
      if (typeof cookieHeader === "string") clickId = getClickIdFromCookieHeader(cookieHeader);
    }
    if (clickId) {
      req[property] = clickId;
      if (options.onCapture) {
        Promise.resolve(options.onCapture(clickId, req)).catch(() => {
          /* persistence errors are the caller's to handle; never block the request */
        });
      }
    }
    next();
  };
}
