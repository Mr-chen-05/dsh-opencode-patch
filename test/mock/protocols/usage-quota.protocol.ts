/**
 * OpenCode Go Usage & Quota Wire Protocol (/usage).
 *
 * Implements:
 * - Protocol: usage
 * - Method: GET
 * - Wire header: Authorization: Bearer <key>
 * - Origin headers: x-opencode-client: cli, x-opencode-project: global
 * - Quota windows: rolling, weekly, monthly
 * - Error formats: 403 EntitlementError for missing Go subscription
 *
 * @module test/mock/protocols/usage-quota.protocol
 */

export interface WireReply {
  readonly body: string;
  readonly contentType?: string;
  readonly status: number;
}

export const USAGE_PROTOCOL = "usage" as const;
export const USAGE_KIND = "usage" as const;
export const USAGE_WIRE_HEADER = "authorization" as const;

export interface QuotaWindow {
  readonly percent: number;
  readonly resetsAt: string;
  readonly status: string;
}

export interface UsageQuotaPayload {
  readonly monthly: QuotaWindow;
  readonly rolling: QuotaWindow;
  readonly weekly: QuotaWindow;
}

export interface MockUsageOptions {
  readonly body?: unknown;
  readonly status?: number;
}

const JSON_TYPE = "application/json";

/**
 * Generate wire response for GET /usage or /zen/go/v1/usage.
 */
export const usageResponse = (options?: MockUsageOptions): WireReply => {
  const status = options?.status ?? 200;
  const body =
    typeof options?.body === "string"
      ? options.body
      : JSON.stringify(
          options?.body ?? {
            monthly: {
              percent: 45.2,
              resetsAt: "2026-11-01T00:00:00.000Z",
              status: "ok",
            },
            rolling: {
              percent: 25.5,
              resetsAt: "2026-11-01T00:00:00.000Z",
              status: "ok",
            },
            weekly: {
              percent: 10,
              resetsAt: "2026-10-24T00:00:00.000Z",
              status: "ok",
            },
          }
        );

  return {
    body,
    contentType: JSON_TYPE,
    status,
  };
};

export const UsageQuotaProtocol = {
  kind: USAGE_KIND,
  protocol: USAGE_PROTOCOL,
  response: usageResponse,
  wireHeader: USAGE_WIRE_HEADER,
} as const;
