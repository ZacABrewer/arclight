export interface Env {
  DB: D1Database;
  REGISTER_LIMITER: RateLimit;
  DEVICE_LIMITER: RateLimit;
  SEND_IP_LIMITER: RateLimit;

  /**
   * APNs topics (iOS bundle IDs) this relay sends for, comma-separated. A device registers with
   * its app's `appId`, which must be one of these; devices registered without one use the first
   * entry. Default: com.moviemethat.arclight.admin,com.moviemethat.arclight.
   */
  APNS_TOPICS?: string;
  /** Older single-topic setting, used only when APNS_TOPICS is not set. */
  APNS_TOPIC?: string;
  /** Apple token-based auth key: the .p8 file contents (PEM, PKCS#8). Secret. */
  APNS_KEY_P8?: string;
  /** Key ID of the .p8 key. Secret. */
  APNS_KEY_ID?: string;
  /** Apple Developer team ID. Secret. */
  APNS_TEAM_ID?: string;
  /**
   * Optional origin overrides, for routing APNs traffic through an HTTP/2-capable forwarder
   * if direct delivery from Workers ever stops working (see README.md, "APNs and HTTP/2").
   */
  APNS_PRODUCTION_ORIGIN?: string;
  APNS_SANDBOX_ORIGIN?: string;

  /** Google service account JSON with FCM send permission. Secret. */
  FCM_SERVICE_ACCOUNT_JSON?: string;
}
