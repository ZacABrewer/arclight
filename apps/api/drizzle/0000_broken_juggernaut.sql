CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`message` text,
	`queued_at` text NOT NULL,
	`started_at` text,
	`ended_at` text
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_name_idx` ON `jobs` (`name`);--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`name` text PRIMARY KEY NOT NULL,
	`interval` text NOT NULL,
	`last_run` text,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
