import { REF_VALUE, isValidClickId } from "./validation.js";

export interface RideBuilderClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  // Which environment this integration runs in. "sandbox" keeps test traffic separate from production.
  environment?: "production" | "sandbox";
}

export interface CheckoutInput {
  orderId: string;
  subtotal: number;
  currency: string;
  clickId: string;
}

export interface ReturnInput {
  returnId: string;
  orderId: string;
  refundAmount: number;
  currency: string;
}

export interface PostbackResult {
  accepted: boolean;
  status: number;
}

export interface HealthResult {
  ok: boolean;
  status: number;
}

export interface RegisterResult {
  integrationId: string;
  status: string;
}

export class RideBuilderError extends Error {
  readonly status?: number;
  readonly errorCode?: string;
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; errorCode?: string; retryable: boolean }) {
    super(message);
    this.name = "RideBuilderError";
    this.status = opts.status;
    this.errorCode = opts.errorCode;
    this.retryable = opts.retryable;
  }
}

const DEFAULT_BASE_URL = "https://api.ridebuilder.com/v1";
const CURRENCY_RE = /^[A-Z]{3}$/;

// Integration-protocol identity for this SDK. Keep SDK_VERSION in sync with package.json.
const SDK_TYPE = "node_sdk";
const SDK_VERSION = "0.4.0";
const DEFAULT_CAPABILITIES = ["click_capture", "order_events", "refund_events"];

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RideBuilderError(`${field} must be a non-empty string`, { retryable: false });
  }
}

function assertPositiveAmount(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RideBuilderError(`${field} must be a positive number`, { retryable: false });
  }
}

function assertCurrency(value: string): void {
  if (typeof value !== "string" || !CURRENCY_RE.test(value)) {
    throw new RideBuilderError("currency must be a 3-letter uppercase ISO-4217 code", {
      retryable: false,
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RideBuilderClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly environment: "production" | "sandbox";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RideBuilderClientOptions) {
    assertNonEmpty(options.apiKey, "apiKey");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.environment = options.environment ?? "production";
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new RideBuilderError("global fetch is unavailable; use Node 18+ or pass options.fetch", {
        retryable: false,
      });
    }
    this.fetchImpl = fetchImpl;
  }

  // order_id is the server-side idempotency key, so a retried checkout never double-counts.
  async reportCheckout(input: CheckoutInput): Promise<PostbackResult> {
    assertNonEmpty(input.orderId, "orderId");
    assertPositiveAmount(input.subtotal, "subtotal");
    assertCurrency(input.currency);
    if (!isValidClickId(input.clickId)) {
      throw new RideBuilderError("clickId must be a valid RideBuilder click_id (UUID v4)", {
        retryable: false,
      });
    }
    return this.post("/postback/checkout", {
      order_id: input.orderId,
      order_subtotal: input.subtotal,
      currency: input.currency,
      ref: REF_VALUE,
      click_id: input.clickId,
    });
  }

  // return_id is the server-side idempotency key, so a retried refund never double-counts.
  async reportReturn(input: ReturnInput): Promise<PostbackResult> {
    assertNonEmpty(input.returnId, "returnId");
    assertNonEmpty(input.orderId, "orderId");
    assertPositiveAmount(input.refundAmount, "refundAmount");
    assertCurrency(input.currency);
    return this.post("/postback/return", {
      return_id: input.returnId,
      order_id: input.orderId,
      refund_amount: input.refundAmount,
      currency: input.currency,
    });
  }

  // Authenticated liveness ping. Proves the API key is valid + active — even on days with no orders —
  // and lets RideBuilder record a heartbeat for this retailer. Ideal in deploy/CI (a failing key throws
  // a terminal RideBuilderError with errorCode "invalid_auth") or on a schedule.
  async healthCheck(): Promise<HealthResult> {
    const res = await this.send("POST", "/postback/health");
    return { ok: true, status: res.status };
  }

  // --- integration protocol ---

  // Handshake: announce this integration on install/startup. Idempotent — re-registering the same
  // (type, environment) updates it. Returns the stable integration id.
  async register(options: { capabilities?: string[] } = {}): Promise<RegisterResult> {
    const res = await this.send("POST", "/integration/register", {
      type: SDK_TYPE,
      environment: this.environment,
      version: SDK_VERSION,
      capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
    });
    const body = (await res.json().catch(() => ({}))) as Partial<RegisterResult>;
    return { integrationId: body.integrationId ?? "", status: body.status ?? "connected" };
  }

  // Self-test: verifies the API key is valid + active. No side effect. Throws a terminal
  // RideBuilderError (errorCode "invalid_auth") on a bad/rotated key — ideal in deploy/CI.
  async verify(): Promise<HealthResult> {
    const res = await this.send("GET", "/integration/verify");
    return { ok: true, status: res.status };
  }

  // Periodic liveness. Call on a schedule (e.g. hourly) so RideBuilder can tell "integration alive" from
  // "integration went dark" independently of order volume.
  async heartbeat(): Promise<HealthResult> {
    const res = await this.send("POST", "/integration/heartbeat", {
      type: SDK_TYPE,
      environment: this.environment,
      version: SDK_VERSION,
    });
    return { ok: true, status: res.status };
  }

  // Opt-in auto-heartbeat for long-running servers: fires one heartbeat now, then every intervalMs
  // (default hourly). Only works where a process stays alive — serverless should schedule heartbeat()
  // externally instead. Failed pings are swallowed (a hiccup must not crash the app), and the timer is
  // unref'd so it never keeps the process from exiting. Call stopHeartbeat() on shutdown.
  startHeartbeat(intervalMs: number = 3_600_000): void {
    this.stopHeartbeat();
    const tick = () => {
      this.heartbeat().catch(() => {
        /* a failed heartbeat must not surface as an unhandled rejection */
      });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    (timer as { unref?: () => void }).unref?.();
    this.heartbeatTimer = timer;
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async post(path: string, payload: unknown): Promise<PostbackResult> {
    const res = await this.send("POST", path, payload);
    return { accepted: true, status: res.status };
  }

  // Shared transport for every call: auth header, per-attempt timeout/abort, retry with backoff on
  // 5xx/429/network errors, terminal throw on other 4xx. Returns the 2xx Response; the body (if any) is
  // JSON-serialized only when a payload is provided (so a bodyless heartbeat sends no Content-Type).
  private async send(method: string, path: string, payload?: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const hasBody = payload !== undefined;
    const body = hasBody ? JSON.stringify(payload) : undefined;
    let lastError: RideBuilderError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
        if (hasBody) headers["Content-Type"] = "application/json";

        const res = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });

        if (res.status >= 200 && res.status < 300) {
          return res;
        }
        if (res.status >= 500 || res.status === 429) {
          lastError = new RideBuilderError(`RideBuilder request failed with ${res.status}`, {
            status: res.status,
            retryable: true,
          });
          continue;
        }
        // 4xx (401 missing/invalid_auth, 413 payload_too_large, 400): terminal.
        const parsed = await readBody(res);
        throw new RideBuilderError(
          parsed?.error
            ? `RideBuilder request rejected (${res.status}): ${parsed.error}`
            : `RideBuilder request rejected with ${res.status}`,
          { status: res.status, errorCode: parsed?.error, retryable: false },
        );
      } catch (err) {
        if (err instanceof RideBuilderError) {
          if (!err.retryable) throw err;
          lastError = err;
          continue;
        }
        // network error / timeout abort — retryable
        lastError = new RideBuilderError(err instanceof Error ? err.message : String(err), {
          retryable: true,
        });
      } finally {
        clearTimeout(timer);
      }
    }

    throw (
      lastError ??
      new RideBuilderError("RideBuilder request failed after retries", { retryable: true })
    );
  }
}

async function readBody(res: Response): Promise<{ error?: string } | null> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return null;
  }
}
