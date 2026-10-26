CREATE TABLE `custom_formats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`include_when_renaming` integer DEFAULT false NOT NULL,
	`specifications` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_formats_name_unique` ON `custom_formats` (`name`);--> statement-breakpoint
CREATE TABLE `delay_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order` integer NOT NULL,
	`tags` text NOT NULL,
	`preferred_protocol` text DEFAULT 'usenet' NOT NULL,
	`usenet_delay_minutes` integer DEFAULT 0 NOT NULL,
	`torrent_delay_minutes` integer DEFAULT 0 NOT NULL,
	`bypass_if_highest_quality` integer DEFAULT false NOT NULL,
	`bypass_if_above_custom_format_score` integer DEFAULT false NOT NULL,
	`minimum_custom_format_score` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delay_profiles_order_idx` ON `delay_profiles` (`order`);--> statement-breakpoint
CREATE TABLE `quality_definitions` (
	`quality_id` integer PRIMARY KEY NOT NULL,
	`min_size` real,
	`max_size` real,
	`preferred_size` real
);
--> statement-breakpoint
CREATE TABLE `quality_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`upgrade_allowed` integer DEFAULT true NOT NULL,
	`cutoff` integer NOT NULL,
	`items` text NOT NULL,
	`min_format_score` integer DEFAULT 0 NOT NULL,
	`cutoff_format_score` integer DEFAULT 0 NOT NULL,
	`min_upgrade_format_score` integer DEFAULT 1 NOT NULL,
	`format_items` text NOT NULL,
	`languages` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quality_profiles_name_unique` ON `quality_profiles` (`name`);--> statement-breakpoint
CREATE TABLE `release_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`required` text NOT NULL,
	`ignored` text NOT NULL,
	`indexer_id` integer,
	`tags` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` integer NOT NULL,
	`tmdb_id` integer,
	`season_number` integer NOT NULL,
	`episode_number` integer NOT NULL,
	`absolute_episode_number` integer,
	`title` text DEFAULT 'TBA' NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`air_date` text,
	`air_date_utc` text,
	`runtime_minutes` integer,
	`monitored` integer DEFAULT true NOT NULL,
	`has_file` integer DEFAULT false NOT NULL,
	`episode_file_id` integer,
	`unverified_scene_numbering` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_series_season_episode_idx` ON `episodes` (`series_id`,`season_number`,`episode_number`);--> statement-breakpoint
CREATE INDEX `episodes_tmdb_id_idx` ON `episodes` (`tmdb_id`);--> statement-breakpoint
CREATE INDEX `episodes_monitored_has_file_idx` ON `episodes` (`monitored`,`has_file`);--> statement-breakpoint
CREATE INDEX `episodes_air_date_utc_idx` ON `episodes` (`air_date_utc`);--> statement-breakpoint
CREATE INDEX `episodes_file_id_idx` ON `episodes` (`episode_file_id`);--> statement-breakpoint
CREATE TABLE `import_exclusions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`title` text NOT NULL,
	`year` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_exclusions_media_tmdb_idx` ON `import_exclusions` (`media_type`,`tmdb_id`);--> statement-breakpoint
CREATE TABLE `media_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_type` text NOT NULL,
	`series_id` integer,
	`movie_id` integer,
	`season_number` integer,
	`relative_path` text NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`date_added` text NOT NULL,
	`quality` text NOT NULL,
	`languages` text NOT NULL,
	`release_group` text,
	`scene_name` text,
	`edition` text,
	`media_info` text,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_files_path_idx` ON `media_files` (`path`);--> statement-breakpoint
CREATE INDEX `media_files_series_season_idx` ON `media_files` (`series_id`,`season_number`);--> statement-breakpoint
CREATE INDEX `media_files_movie_idx` ON `media_files` (`movie_id`);--> statement-breakpoint
CREATE TABLE `movies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tmdb_id` integer NOT NULL,
	`imdb_id` text,
	`title` text NOT NULL,
	`original_title` text NOT NULL,
	`sort_title` text NOT NULL,
	`clean_title` text NOT NULL,
	`year` integer NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`in_cinemas` text,
	`digital_release` text,
	`physical_release` text,
	`runtime_minutes` integer,
	`studio` text,
	`genres` text NOT NULL,
	`images` text NOT NULL,
	`ratings` text NOT NULL,
	`certification` text,
	`original_language` text NOT NULL,
	`collection` text,
	`path` text NOT NULL,
	`root_folder_path` text NOT NULL,
	`quality_profile_id` integer NOT NULL,
	`minimum_availability` text DEFAULT 'released' NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`tags` text NOT NULL,
	`added` text NOT NULL,
	`last_refreshed` text,
	`has_file` integer DEFAULT false NOT NULL,
	`movie_file_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `movies_tmdb_id_idx` ON `movies` (`tmdb_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `movies_path_idx` ON `movies` (`path`);--> statement-breakpoint
CREATE INDEX `movies_imdb_id_idx` ON `movies` (`imdb_id`);--> statement-breakpoint
CREATE INDEX `movies_clean_title_idx` ON `movies` (`clean_title`);--> statement-breakpoint
CREATE INDEX `movies_monitored_has_file_idx` ON `movies` (`monitored`,`has_file`);--> statement-breakpoint
CREATE TABLE `root_folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`media_type` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `root_folders_path_idx` ON `root_folders` (`path`);--> statement-breakpoint
CREATE TABLE `seasons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seasons_series_season_idx` ON `seasons` (`series_id`,`season_number`);--> statement-breakpoint
CREATE TABLE `series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tmdb_id` integer NOT NULL,
	`tvdb_id` integer,
	`imdb_id` text,
	`title` text NOT NULL,
	`sort_title` text NOT NULL,
	`clean_title` text NOT NULL,
	`year` integer NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`network` text,
	`runtime_minutes` integer,
	`genres` text NOT NULL,
	`images` text NOT NULL,
	`ratings` text NOT NULL,
	`certification` text,
	`original_language` text NOT NULL,
	`path` text NOT NULL,
	`root_folder_path` text NOT NULL,
	`quality_profile_id` integer NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`monitor_new_items` text DEFAULT 'all' NOT NULL,
	`series_type` text DEFAULT 'standard' NOT NULL,
	`season_folder` integer DEFAULT true NOT NULL,
	`use_scene_numbering` integer DEFAULT false NOT NULL,
	`tags` text NOT NULL,
	`added` text NOT NULL,
	`last_refreshed` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `series_tmdb_id_idx` ON `series` (`tmdb_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `series_path_idx` ON `series` (`path`);--> statement-breakpoint
CREATE INDEX `series_tvdb_id_idx` ON `series` (`tvdb_id`);--> statement-breakpoint
CREATE INDEX `series_clean_title_idx` ON `series` (`clean_title`);--> statement-breakpoint
CREATE INDEX `series_monitored_idx` ON `series` (`monitored`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_label_idx` ON `tags` (`label`);