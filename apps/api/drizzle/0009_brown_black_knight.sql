CREATE TABLE `download_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tracked_download_id` integer NOT NULL,
	`download_id` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`message` text,
	`data` text,
	`time` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `download_events_tracked_idx` ON `download_events` (`tracked_download_id`,`time`);--> statement-breakpoint
CREATE INDEX `download_events_time_idx` ON `download_events` (`time`);--> statement-breakpoint
ALTER TABLE `tracked_downloads` ADD `phase` text;--> statement-breakpoint
ALTER TABLE `tracked_downloads` ADD `live` text;--> statement-breakpoint
ALTER TABLE `tracked_downloads` ADD `downloaded_bytes` integer;--> statement-breakpoint
ALTER TABLE `tracked_downloads` ADD `progress_at` text;--> statement-breakpoint
ALTER TABLE `tracked_downloads` ADD `stalled_since` text;--> statement-breakpoint
ALTER TABLE `tracked_downloads` ADD `state_code` text;--> statement-breakpoint
ALTER TABLE `tracked_downloads` ADD `disk_shortfall` integer;