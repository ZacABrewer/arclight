CREATE TABLE `video_fingerprints` (
	`media_file_id` integer NOT NULL,
	`part` text NOT NULL,
	`file_stamp` text NOT NULL,
	`frame_ms` real NOT NULL,
	`start_ms` integer DEFAULT 0 NOT NULL,
	`hashes` blob NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`media_file_id`, `part`),
	FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `video_segment_overrides` (
	`media_file_id` integer PRIMARY KEY NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `video_segment_scans` (
	`series_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`stamp` text,
	`status` text NOT NULL,
	`error` text,
	`scanned_at` text,
	PRIMARY KEY(`series_id`, `season_number`),
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `video_segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_file_id` integer NOT NULL,
	`type` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`source` text NOT NULL,
	`confidence` real,
	`file_stamp` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `video_segments_file_idx` ON `video_segments` (`media_file_id`);