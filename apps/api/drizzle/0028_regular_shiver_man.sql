CREATE TABLE `soulseek_downloads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`album_id` integer NOT NULL,
	`artist_id` integer NOT NULL,
	`username` text NOT NULL,
	`directory` text NOT NULL,
	`files` text NOT NULL,
	`quality_name` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `soulseek_downloads_status_idx` ON `soulseek_downloads` (`status`);--> statement-breakpoint
CREATE INDEX `soulseek_downloads_album_idx` ON `soulseek_downloads` (`album_id`);--> statement-breakpoint
CREATE TABLE `music_playlist_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`artist` text NOT NULL,
	`album` text,
	`duration_ms` integer,
	`isrc` text,
	`status` text NOT NULL,
	`match_method` text,
	`recording_mbid` text,
	`release_group_mbid` text,
	`artist_mbid` text,
	`artist_id` integer,
	`album_id` integer,
	`track_id` integer,
	FOREIGN KEY (`playlist_id`) REFERENCES `music_playlists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `music_playlist_entries_playlist_idx` ON `music_playlist_entries` (`playlist_id`,`position`);--> statement-breakpoint
CREATE TABLE `music_playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`want` text DEFAULT 'none' NOT NULL,
	`add_artists` integer DEFAULT false NOT NULL,
	`root_folder_path` text,
	`quality_profile_id` integer,
	`search_on_want` integer DEFAULT false NOT NULL,
	`write_m3u` integer DEFAULT true NOT NULL,
	`targets` text NOT NULL,
	`target_state` text NOT NULL,
	`owned_album_ids` text NOT NULL,
	`sync_interval_hours` integer DEFAULT 24 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source_title` text,
	`last_sync_at` text,
	`last_sync_status` text DEFAULT 'never' NOT NULL,
	`last_sync_message` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `album_type_profiles` ADD `edition_preference` text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE `album_type_profiles` ADD `preferred_countries` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `album_type_profiles` ADD `preferred_formats` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `monitored` integer DEFAULT true NOT NULL;