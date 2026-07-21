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

// --- optional Express-style middleware ---

interface CaptureRequestLike {
  url?: string;
  originalUrl?: string;
  query?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CaptureOptions {
  property?: string;
  onCapture?: (clickId: string, req: CaptureRequestLike) => void | Promise<void>;
}

// Reads click_id off the incoming request and stashes it on req[property] (default `ridebuilderClickId`).
// Does not persist it — hand it to onCapture (or read req[property]) to bind it onto your cart/order.
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
