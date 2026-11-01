/** A notification as the relay hands it to a provider. Never stored or logged. */
export interface Notification {
  title: string;
  body: string;
  data?: Record<string, string>;
  badge?: number;
  threadId?: string;
}

export type SendResult =
  | { kind: "ok" }
  /** The provider says the token is no longer valid: the device record must be deleted. */
  | { kind: "invalid-token"; reason: string }
  /** The provider rejected the payload as too large. */
  | { kind: "too-large"; reason: string }
  /** Any other failure. `reason` is a provider error code, never notification content. */
  | { kind: "error"; status: number; reason: string; retryAfter?: string };

/** Largest notification payload both APNs and FCM accept, in bytes. */
export const MAX_PAYLOAD_BYTES = 4096;
