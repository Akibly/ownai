/**
 * Normalized error vocabulary shared by the bridge, adapters, relay and MCP facade.
 * Every failure a client can observe maps to exactly one code.
 */

export const ERROR_CODES = {
  invalid_api_key: { status: 401, type: "authentication_error" },
  forbidden_origin: { status: 403, type: "permission_error" },
  invalid_request: { status: 400, type: "invalid_request_error" },
  unsupported_parameter: { status: 400, type: "invalid_request_error" },
  unsupported_feature: { status: 400, type: "invalid_request_error" },
  payload_too_large: { status: 413, type: "invalid_request_error" },
  model_not_found: { status: 404, type: "invalid_request_error" },
  // 409 rather than 401: a 401 makes OpenAI SDKs report a bad gateway key (ADR-013).
  login_required: { status: 409, type: "provider_auth_error" },
  policy_disabled: { status: 403, type: "permission_error" },
  quota_exhausted: { status: 429, type: "rate_limit_error" },
  rate_limited: { status: 429, type: "rate_limit_error" },
  queue_full: { status: 503, type: "server_error" },
  provider_unavailable: { status: 503, type: "server_error" },
  provider_error: { status: 502, type: "server_error" },
  timeout: { status: 504, type: "server_error" },
  cancelled: { status: 499, type: "server_error" },
  device_offline: { status: 503, type: "server_error" },
  remote_disabled: { status: 403, type: "permission_error" },
  internal_error: { status: 500, type: "server_error" },
} as const satisfies Record<string, { status: number; type: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface BridgeErrorDetails {
  param?: string;
  provider?: string;
  connection_id?: string;
  /** Seconds until retry is sensible. Only set when the provider actually reported it. */
  retry_after_s?: number;
  /** Capability names relevant to an unsupported_feature error. */
  capability?: string;
  /** True once the prompt may have reached the provider; such requests are never retried or re-routed. */
  generation_started?: boolean;
}

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly details: BridgeErrorDetails;

  constructor(code: ErrorCode, message: string, details: BridgeErrorDetails = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_CODES[this.code].status;
  }
}

export function isBridgeError(err: unknown): err is BridgeError {
  return err instanceof BridgeError;
}

/** OpenAI-shaped error body with a `bridge` extension. */
export interface ErrorBody {
  error: {
    message: string;
    type: string;
    code: ErrorCode;
    param: string | null;
    bridge: {
      request_id: string;
      provider?: string;
      connection_id?: string;
      retry_after_s?: number;
      capability?: string;
    };
  };
}

export function toErrorBody(err: BridgeError, requestId: string): ErrorBody {
  const { param, provider, connection_id, retry_after_s, capability } = err.details;
  return {
    error: {
      message: err.message,
      type: ERROR_CODES[err.code].type,
      code: err.code,
      param: param ?? null,
      bridge: {
        request_id: requestId,
        ...(provider !== undefined && { provider }),
        ...(connection_id !== undefined && { connection_id }),
        ...(retry_after_s !== undefined && { retry_after_s }),
        ...(capability !== undefined && { capability }),
      },
    },
  };
}
