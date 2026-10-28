CREATE TABLE `audio_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_type` text NOT NULL,
	`artist_id` integer,
	`album_id` integer,
	`author_id` integer,
	`book_id` integer,
	`path` text NOT NULL,
	`relative_path` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`date_added` text NOT NULL,
	`mtime` text,
	`quality` text NOT NULL,
	`release_group` text,
	`scene_name` text,
	`codec` text,
	`container` text,
	`bitrate_kbps` integer,
	`sample_rate_hz` integer,
	`bit_depth` integer,
	`channels` integer,
	`duration_ms` integer,
	`disc_number` integer,
	`track_number` integer,
	`part_number` integer,
	`chapter_count` integer,
	`tags` text,
	`media_info` text,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audio_files_path_idx` ON `audio_files` (`path`);--> statement-breakpoint
CREATE INDEX `audio_files_album_idx` ON `audio_files` (`album_id`);--> statement-breakpoint
CREATE INDEX `audio_files_book_idx` ON `audio_files` (`book_id`);--> statement-breakpoint
CREATE INDEX `audio_files_artist_idx` ON `audio_files` (`artist_id`);--> statement-breakpoint
CREATE INDEX `audio_files_author_idx` ON `audio_files` (`author_id`);--> statement-breakpoint
CREATE TABLE `audio_import_exclusions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_type` text NOT NULL,
	`foreign_id` text NOT NULL,
	`title` text NOT NULL,
	`year` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audio_import_exclusions_media_foreign_idx` ON `audio_import_exclusions` (`media_type`,`foreign_id`);--> statement-breakpoint
CREATE TABLE `album_releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`album_id` integer NOT NULL,
	`mb_release_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text,
	`country` text,
	`date` text,
	`labels` text NOT NULL,
	`catalog_number` text,
	`barcode` text,
	`formats` text NOT NULL,
	`medium_count` integer DEFAULT 0 NOT NULL,
	`track_count` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`media` text NOT NULL,
	`disambiguation` text,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `album_releases_mb_release_id_idx` ON `album_releases` (`mb_release_id`);--> statement-breakpoint
CREATE INDEX `album_releases_album_idx` ON `album_releases` (`album_id`);--> statement-breakpoint
CREATE TABLE `album_type_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`primary_types` text NOT NULL,
	`secondary_types` text NOT NULL,
	`release_statuses` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `album_type_profiles_name_idx` ON `album_type_profiles` (`name`);--> statement-breakpoint
CREATE TABLE `albums` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`artist_id` integer NOT NULL,
	`mb_release_group_id` text NOT NULL,
	`title` text NOT NULL,
	`clean_title` text NOT NULL,
	`disambiguation` text,
	`primary_type` text NOT NULL,
	`secondary_types` text NOT NULL,
	`release_date` text,
	`year` integer,
	`overview` text DEFAULT '' NOT NULL,
	`genres` text NOT NULL,
	`images` text NOT NULL,
	`ratings` text NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`any_release_ok` integer DEFAULT true NOT NULL,
	`selected_release_id` integer,
	`added` text NOT NULL,
	`last_refreshed` text,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `albums_mb_release_group_id_idx` ON `albums` (`mb_release_group_id`);--> statement-breakpoint
CREATE INDEX `albums_artist_idx` ON `albums` (`artist_id`);--> statement-breakpoint
CREATE INDEX `albums_monitored_release_date_idx` ON `albums` (`monitored`,`release_date`);--> statement-breakpoint
CREATE INDEX `albums_clean_title_idx` ON `albums` (`clean_title`);--> statement-breakpoint
CREATE TABLE `artists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mb_artist_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_name` text NOT NULL,
	`clean_name` text NOT NULL,
	`disambiguation` text,
	`artist_type` text,
	`status` text DEFAULT 'continuing' NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`genres` text NOT NULL,
	`images` text NOT NULL,
	`links` text NOT NULL,
	`aliases` text NOT NULL,
	`path` text NOT NULL,
	`root_folder_path` text NOT NULL,
	`quality_profile_id` integer NOT NULL,
	`album_type_profile_id` integer NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`monitor_new_albums` text DEFAULT 'all' NOT NULL,
	`tags` text NOT NULL,
	`added` text NOT NULL,
	`last_refreshed` text,
	`next_refresh_at` text,
	FOREIGN KEY (`album_type_profile_id`) REFERENCES `album_type_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artists_mb_artist_id_idx` ON `artists` (`mb_artist_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artists_path_idx` ON `artists` (`path`);--> statement-breakpoint
CREATE INDEX `artists_clean_name_idx` ON `artists` (`clean_name`);--> statement-breakpoint
CREATE INDEX `artists_next_refresh_idx` ON `artists` (`next_refresh_at`);--> statement-breakpoint
CREATE TABLE `tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`album_id` integer NOT NULL,
	`album_release_id` integer NOT NULL,
	`mb_track_id` text,
	`mb_recording_id` text,
	`medium_number` integer DEFAULT 1 NOT NULL,
	`absolute_number` integer NOT NULL,
	`track_number` integer NOT NULL,
	`title` text NOT NULL,
	`duration_ms` integer,
	`artist_credit` text,
	`has_file` integer DEFAULT false NOT NULL,
	`audio_file_id` integer,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`album_release_id`) REFERENCES `album_releases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_release_position_idx` ON `tracks` (`album_release_id`,`medium_number`,`track_number`);--> statement-breakpoint
CREATE INDEX `tracks_album_idx` ON `tracks` (`album_id`);--> statement-breakpoint
CREATE INDEX `tracks_mb_recording_id_idx` ON `tracks` (`mb_recording_id`);--> statement-breakpoint
CREATE INDEX `tracks_audio_file_idx` ON `tracks` (`audio_file_id`);--> statement-breakpoint
CREATE TABLE `metadata_cache` (
	`provider` text NOT NULL,
	`key` text NOT NULL,
	`body` text NOT NULL,
	`etag` text,
	`fetched_at` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`provider`, `key`)
);
--> statement-breakpoint
CREATE INDEX `metadata_cache_expires_idx` ON `metadata_cache` (`expires_at`);--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `media_domain` text DEFAULT 'video' NOT NULL;--> statement-breakpoint
ALTER TABLE `tracked_downloads` ADD `artist_id` integer;--> statement-breakpoint
ALTER TABLE `tracked_downloads` ADD `album_ids` text;--> statement-breakpoint
ALTER TABLE `tracked_downloads` ADD `author_id` integer;--> statement-breakpoint
ALTER TABLE `tracked_downloads` ADD `book_ids` text;--> statement-breakpoint
ALTER TABLE `history` ADD `artist_id` integer;--> statement-breakpoint
ALTER TABLE `history` ADD `album_ids` text;--> statement-breakpoint
ALTER TABLE `history` ADD `author_id` integer;--> statement-breakpoint
ALTER TABLE `history` ADD `book_ids` text;--> statement-breakpoint
CREATE INDEX `history_artist_id_idx` ON `history` (`artist_id`);--> statement-breakpoint
CREATE INDEX `history_author_id_idx` ON `history` (`author_id`);--> statement-breakpoint
ALTER TABLE `blocklist` ADD `artist_id` integer;--> statement-breakpoint
ALTER TABLE `blocklist` ADD `album_ids` text;--> statement-breakpoint
ALTER TABLE `blocklist` ADD `author_id` integer;--> statement-breakpoint
ALTER TABLE `blocklist` ADD `book_ids` text;--> statement-breakpoint
CREATE INDEX `blocklist_artist_id_idx` ON `blocklist` (`artist_id`);--> statement-breakpoint
CREATE INDEX `blocklist_author_id_idx` ON `blocklist` (`author_id`);--> statement-breakpoint
ALTER TABLE `pending_releases` ADD `artist_id` integer;--> statement-breakpoint
ALTER TABLE `pending_releases` ADD `album_ids` text;--> statement-breakpoint
ALTER TABLE `pending_releases` ADD `author_id` integer;--> statement-breakpoint
ALTER TABLE `pending_releases` ADD `book_ids` text;--> statement-breakpoint
ALTER TABLE `release_decisions` ADD `artist_id` integer;--> statement-breakpoint
ALTER TABLE `release_decisions` ADD `album_ids` text;--> statement-breakpoint
ALTER TABLE `release_decisions` ADD `author_id` integer;--> statement-breakpoint
ALTER TABLE `release_decisions` ADD `book_ids` text;--> statement-breakpoint
ALTER TABLE `imported_downloads` ADD `artist_id` integer;--> statement-breakpoint
ALTER TABLE `imported_downloads` ADD `album_ids` text;--> statement-breakpoint
ALTER TABLE `imported_downloads` ADD `author_id` integer;--> statement-breakpoint
ALTER TABLE `imported_downloads` ADD `book_ids` text;