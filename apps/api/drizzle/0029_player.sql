CREATE TABLE `playback_bookmarks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`item_key` text NOT NULL,
	`position_ms` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playback_bookmarks_user_item_idx` ON `playback_bookmarks` (`user_id`,`item_key`);--> statement-breakpoint
CREATE TABLE `playback_plays` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`item_key` text NOT NULL,
	`at` text NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`device_id` text,
	`device_name` text,
	`play_method` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playback_plays_user_at_idx` ON `playback_plays` (`user_id`,`at`);--> statement-breakpoint
CREATE INDEX `playback_plays_item_idx` ON `playback_plays` (`item_key`);--> statement-breakpoint
CREATE TABLE `playback_progress` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`item_key` text NOT NULL,
	`position_ms` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`played` integer DEFAULT false NOT NULL,
	`play_count` integer DEFAULT 0 NOT NULL,
	`last_played_at` text,
	`updated_at` text NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`prefs` text DEFAULT '{}' NOT NULL,
	`device_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playback_progress_user_item_idx` ON `playback_progress` (`user_id`,`item_key`);--> statement-breakpoint
CREATE INDEX `playback_progress_user_played_at_idx` ON `playback_progress` (`user_id`,`last_played_at`);--> statement-breakpoint
CREATE TABLE `playback_queue` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`queue` text NOT NULL,
	`device_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_playlist_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`track_id` integer NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `user_playlists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_playlist_tracks_position_idx` ON `user_playlist_tracks` (`playlist_id`,`position`);--> statement-breakpoint
CREATE INDEX `user_playlist_tracks_track_idx` ON `user_playlist_tracks` (`track_id`);--> statement-breakpoint
CREATE TABLE `user_playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_playlists_user_idx` ON `user_playlists` (`user_id`);