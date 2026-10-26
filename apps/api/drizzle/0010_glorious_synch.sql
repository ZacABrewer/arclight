CREATE TABLE `transfer_download_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tracked_download_id` integer NOT NULL,
	`info_hash` text NOT NULL,
	`resolution` text NOT NULL,
	`time` text NOT NULL,
	`samples` integer NOT NULL,
	`download_rate` real NOT NULL,
	`upload_rate` real NOT NULL,
	`peers` real NOT NULL,
	`seeds` real NOT NULL,
	`progress` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfer_download_points_key_idx` ON `transfer_download_points` (`tracked_download_id`,`resolution`,`time`);--> statement-breakpoint
CREATE INDEX `transfer_download_points_time_idx` ON `transfer_download_points` (`resolution`,`time`);--> statement-breakpoint
CREATE TABLE `transfer_engine_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`resolution` text NOT NULL,
	`time` text NOT NULL,
	`samples` integer NOT NULL,
	`download_rate` real NOT NULL,
	`upload_rate` real NOT NULL,
	`peers` real NOT NULL,
	`active_torrents` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfer_engine_points_key_idx` ON `transfer_engine_points` (`resolution`,`time`);--> statement-breakpoint
CREATE TABLE `vpn_metric_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`time` text NOT NULL,
	`type` text NOT NULL,
	`message` text,
	`port` integer
);
--> statement-breakpoint
CREATE INDEX `vpn_metric_events_time_idx` ON `vpn_metric_events` (`time`);--> statement-breakpoint
CREATE TABLE `vpn_metric_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`resolution` text NOT NULL,
	`time` text NOT NULL,
	`samples` integer NOT NULL,
	`connected` real NOT NULL,
	`kill_switch` real NOT NULL,
	`warning` real NOT NULL,
	`forwarded_port` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vpn_metric_points_key_idx` ON `vpn_metric_points` (`resolution`,`time`);