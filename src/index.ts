export {
  REF_VALUE,
  COOKIE_NAME,
  CLICK_ID_RE,
  isValidClickId,
  parseAttributionCookie,
  parseCookieHeader,
} from "./validation.js";
export type { Attribution } from "./validation.js";

export {
  getClickIdFromUrl,
  getClickIdFromSearchParams,
  getClickIdFromQuery,
  getClickIdFromCookieHeader,
  capture,
} from "./capture.js";
export type { CaptureOptions } from "./capture.js";

export { RideBuilderClient, RideBuilderError } from "./client.js";
export type {
  RideBuilderClientOptions,
  CheckoutInput,
  ReturnInput,
  PostbackResult,
  HealthResult,
  RegisterResult,
} from "./client.js";
