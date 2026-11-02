CREATE TABLE `notification_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notification_id` integer,
	`destination_id` integer,
	`event_type` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`error` text,
	`code` text,
	`test` integer DEFAULT false NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `user_notification_destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_deliveries_notification_idx` ON `notification_deliveries` (`notification_id`,`id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_destination_idx` ON `notification_deliveries` (`destination_id`,`id`);--> statement-breakpoint
CREATE TABLE `user_notification_destinations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`implementation` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`events` text NOT NULL,
	`settings` text NOT NULL,
	`templates` text DEFAULT '{}' NOT NULL,
	`quiet_hours` text,
	`added_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_notification_destinations_user_idx` ON `user_notification_destinations` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_notification_held` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`destination_id` integer NOT NULL,
	`event` text NOT NULL,
	`held_at` text NOT NULL,
	`reason` text DEFAULT 'quiet' NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `user_notification_destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_notification_held_destination_idx` ON `user_notification_held` (`destination_id`);--> statement-breakpoint
ALTER TABLE `notification_held` ADD `reason` text DEFAULT 'quiet' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `filters` text DEFAULT '{"mediaTypes":[],"qualities":[],"users":[]}' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `templates` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `quiet_hours` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `rate_limit_per_minute` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `max_attempts` integer DEFAULT 3 NOT NULL;