export const REF_VALUE = "ridebuilder";
export const COOKIE_NAME = "ridebuilder_attribution";

// Same UUID-v4 shape the browser snippet enforces before writing the cookie.
export const CLICK_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidClickId(value: unknown): value is string {
  return typeof value === "string" && CLICK_ID_RE.test(value);
}

export interface Attribution {
  click_id: string;
  ref: string;
  clicked_at?: string;
}

// Parse the raw `ridebuilder_attribution` cookie value (URL-encoded JSON the snippet wrote).
export function parseAttributionCookie(rawValue: string): Attribution | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(rawValue));
    if (parsed && isValidClickId(parsed.click_id) && parsed.ref === REF_VALUE) {
      return { click_id: parsed.click_id, ref: parsed.ref, clicked_at: parsed.clicked_at };
    }
  } catch {
    /* malformed cookie */
  }
  return null;
}

export function parseCookieHeader(cookieHeader: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
