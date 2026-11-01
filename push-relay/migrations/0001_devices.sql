-- Arclight push relay: one row per app registration. Holds no notification content, ever.
--   device_id       random 128-bit identifier (base64url), returned to the app
--   platform        'ios' or 'android'
--   token           APNs device token or FCM registration token
--   secret_hash     SHA-256 (hex) of the random 256-bit secret; the secret itself is never stored
--   app_version     optional app version string from registration
--   environment     APNs environment: 'production' or 'sandbox' (development builds)
--   created_at      ms since epoch
--   last_used_at    ms since epoch; rows unused for 90 days are deleted by the daily cron
--   send_tokens     per-device send rate limit: token bucket level (capacity 10)
--   send_refill_at  ms since epoch of the last bucket update
CREATE TABLE devices (
  device_id      TEXT PRIMARY KEY NOT NULL,
  platform       TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  token          TEXT NOT NULL,
  secret_hash    TEXT NOT NULL,
  app_version    TEXT,
  environment    TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox')),
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER NOT NULL,
  send_tokens    REAL NOT NULL DEFAULT 10,
  send_refill_at INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX devices_last_used_at ON devices (last_used_at);
