CREATE TABLE `mobile_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`relay_device_id` text NOT NULL,
	`relay_secret` text NOT NULL,
	`platform` text NOT NULL,
	`device_name` text DEFAULT '' NOT NULL,
	`app_version` text,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_error` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_devices_relay_device_idx` ON `mobile_devices` (`relay_device_id`);--> statement-breakpoint
CREATE INDEX `mobile_devices_user_idx` ON `mobile_devices` (`user_id`);