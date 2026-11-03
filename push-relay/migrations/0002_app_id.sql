-- App ID (iOS bundle ID / Android application ID) of the app that registered the device. The
-- relay serves more than one app (Arclight Admin and the Arclight player), and APNs needs the
-- matching topic per device. NULL for registrations from apps that did not send one: those use
-- the default topic (the first entry of APNS_TOPICS, normally com.moviemethat.arclight.admin).
ALTER TABLE devices ADD COLUMN app_id TEXT;
