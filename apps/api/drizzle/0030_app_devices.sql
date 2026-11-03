CREATE TABLE `app_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`app_version` text NOT NULL,
	`token_hash` text NOT NULL,
	`method` text DEFAULT 'password' NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_devices_token_idx` ON `app_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `app_devices_user_idx` ON `app_devices` (`user_id`);