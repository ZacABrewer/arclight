CREATE TABLE `household_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`initial` text NOT NULL,
	`is_owner` integer DEFAULT false NOT NULL,
	`pin_hash` text,
	`content_restrictions` text,
	`settings` text DEFAULT '{}' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `household_profiles_user_idx` ON `household_profiles` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `household_profiles_owner_idx` ON `household_profiles` (`user_id`) WHERE "household_profiles"."is_owner" = 1;--> statement-breakpoint
CREATE TABLE `profile_my_list` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`item_key` text NOT NULL,
	`added_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `household_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_my_list_item_idx` ON `profile_my_list` (`profile_id`,`item_key`);--> statement-breakpoint
CREATE TABLE `profile_playback_queue` (
	`profile_id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`queue` text NOT NULL,
	`device_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `household_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE INDEX `video_segments_file_idx` ON `video_segments` (`media_file_id`);--> statement-breakpoint
DROP INDEX `playback_progress_user_item_idx`;--> statement-breakpoint
ALTER TABLE `playback_progress` ADD `profile_id` integer REFERENCES household_profiles(id) ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX `playback_progress_profile_item_idx` ON `playback_progress` (`profile_id`,`item_key`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `profile_id` integer REFERENCES household_profiles(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `app_devices` ADD `profile_id` integer REFERENCES household_profiles(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `playback_bookmarks` ADD `profile_id` integer REFERENCES household_profiles(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `playback_bookmarks_profile_item_idx` ON `playback_bookmarks` (`profile_id`,`item_key`);--> statement-breakpoint
ALTER TABLE `playback_plays` ADD `profile_id` integer REFERENCES household_profiles(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `playback_plays_profile_at_idx` ON `playback_plays` (`profile_id`,`at`);--> statement-breakpoint
ALTER TABLE `user_playlists` ADD `profile_id` integer REFERENCES household_profiles(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `user_playlists_profile_idx` ON `user_playlists` (`profile_id`);