ALTER TABLE `users` ADD `app_access` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `local_password` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- Accounts made by a media-server sign-in or an import carry a random or unusable hash: mark them
-- so they cannot be promoted to admin until an admin sets a password.
UPDATE `users` SET `local_password` = 0 WHERE `password_hash` NOT LIKE 'scrypt$%' OR (`role` <> 'admin' AND json_extract(`settings`, '$.mediaServerLink') IS NOT NULL);
