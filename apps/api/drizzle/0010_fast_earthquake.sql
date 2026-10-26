CREATE TABLE `notification_held` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notification_id` integer NOT NULL,
	`event` text NOT NULL,
	`held_at` text NOT NULL,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_held_notification_idx` ON `notification_held` (`notification_id`);--> statement-breakpoint
CREATE TABLE `daily_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`generated_at` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `daily_summaries_generated_idx` ON `daily_summaries` (`generated_at`);--> statement-breakpoint
CREATE TABLE `kill_switch_lockdowns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`reason` text,
	`paused_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kill_switch_lockdowns_started_idx` ON `kill_switch_lockdowns` (`started_at`);--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_download_stalled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_kill_switch` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_kill_switch_resumed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_import_problem` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_disk_space_low` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_download_recovered` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_daily_summary` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `respect_quiet_hours` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- Existing chat/push connections that hear about health issues also get the new download alerts.
UPDATE `notifications` SET `on_download_stalled` = 1, `on_kill_switch` = 1, `on_kill_switch_resumed` = 1, `on_import_problem` = 1, `on_disk_space_low` = 1, `on_download_recovered` = 1, `on_daily_summary` = 1 WHERE `on_health_issue` = 1 AND `implementation` NOT IN ('jellyfin', 'emby', 'plex');
