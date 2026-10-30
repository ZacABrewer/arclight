CREATE TABLE `health_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`source` text,
	`file_id` integer,
	`media_type` text NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`series_id` integer,
	`movie_id` integer,
	`artist_id` integer,
	`album_id` integer,
	`author_id` integer,
	`book_id` integer,
	`episode_ids` text NOT NULL,
	`details` text NOT NULL,
	`data` text NOT NULL,
	`ignored_signature` text,
	`first_seen` text NOT NULL,
	`last_checked` text NOT NULL,
	`fixed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `health_findings_key_idx` ON `health_findings` (`key`);--> statement-breakpoint
CREATE INDEX `health_findings_status_idx` ON `health_findings` (`status`);--> statement-breakpoint
CREATE INDEX `health_findings_file_idx` ON `health_findings` (`source`,`file_id`);--> statement-breakpoint
CREATE TABLE `health_scan_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`file_id` integer NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer,
	`mtime_ms` integer,
	`mode` text NOT NULL,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `health_scan_files_file_idx` ON `health_scan_files` (`source`,`file_id`);