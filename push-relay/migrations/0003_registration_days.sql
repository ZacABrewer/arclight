-- Global daily registration cap (REGISTER_DAILY_CAP): one counter row per UTC day. Holds no
-- device, token or address data; rows older than a week are deleted by the daily cron.
--   day    UTC date, YYYY-MM-DD
--   count  registrations accepted that day
CREATE TABLE registration_days (
  day   TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL
) STRICT;
