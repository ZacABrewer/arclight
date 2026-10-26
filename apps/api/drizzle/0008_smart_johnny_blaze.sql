CREATE TABLE `episode_version_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`episode_id` integer NOT NULL,
	`version_tag` text NOT NULL,
	`media_file_id` integer NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episode_version_files_episode_version_idx` ON `episode_version_files` (`episode_id`,`version_tag`);--> statement-breakpoint
CREATE INDEX `episode_version_files_file_idx` ON `episode_version_files` (`media_file_id`);--> statement-breakpoint
CREATE TABLE `release_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` text NOT NULL,
	`time` text NOT NULL,
	`source` text NOT NULL,
	`media_type` text,
	`item_key` text NOT NULL,
	`series_id` integer,
	`episode_ids` text NOT NULL,
	`movie_id` integer,
	`guid` text NOT NULL,
	`indexer_id` integer NOT NULL,
	`title` text NOT NULL,
	`quality` text NOT NULL,
	`formats` text NOT NULL,
	`score` integer NOT NULL,
	`approved` integer NOT NULL,
	`rejections` text NOT NULL,
	`chosen` integer DEFAULT false NOT NULL,
	`rank` integer
);
--> statement-breakpoint
CREATE INDEX `release_decisions_batch_idx` ON `release_decisions` (`batch_id`);--> statement-breakpoint
CREATE INDEX `release_decisions_item_idx` ON `release_decisions` (`item_key`,`time`);--> statement-breakpoint
CREATE INDEX `release_decisions_series_idx` ON `release_decisions` (`series_id`);--> statement-breakpoint
CREATE INDEX `release_decisions_movie_idx` ON `release_decisions` (`movie_id`);--> statement-breakpoint
CREATE INDEX `release_decisions_time_idx` ON `release_decisions` (`time`);--> statement-breakpoint
CREATE TABLE `scene_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` integer NOT NULL,
	`kind` text NOT NULL,
	`scene_season` integer,
	`scene_episode` integer,
	`scene_absolute` integer,
	`tvdb_season` integer,
	`tvdb_episode` integer,
	`tvdb_absolute` integer,
	`scene_title` text,
	`source` text NOT NULL,
	`comment` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scene_mappings_series_idx` ON `scene_mappings` (`series_id`);--> statement-breakpoint
CREATE INDEX `scene_mappings_source_idx` ON `scene_mappings` (`source`);--> statement-breakpoint
CREATE TABLE `tracker_accounts` (
	`indexer_id` integer PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tracker_stats` (
	`indexer_id` integer PRIMARY KEY NOT NULL,
	`hosts` text NOT NULL,
	`torrents` integer DEFAULT 0 NOT NULL,
	`seeding` integer DEFAULT 0 NOT NULL,
	`uploaded` integer DEFAULT 0 NOT NULL,
	`downloaded` integer DEFAULT 0 NOT NULL,
	`seeding_time_ms` integer DEFAULT 0 NOT NULL,
	`hnr_pending` integer DEFAULT 0 NOT NULL,
	`engine_updated_at` text,
	`account_ratio` real,
	`account_uploaded` integer,
	`account_downloaded` integer,
	`account_buffer` integer,
	`account_hnr_count` integer,
	`account_seed_bonus` real,
	`account_updated_at` text,
	`account_error` text
);
--> statement-breakpoint
CREATE TABLE `cross_seed_searches` (
	`media_file_id` integer PRIMARY KEY NOT NULL,
	`searched_at` text NOT NULL,
	`candidates` integer DEFAULT 0 NOT NULL,
	`added` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cross_seeds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_file_id` integer,
	`indexer_id` integer,
	`info_hash` text NOT NULL,
	`title` text NOT NULL,
	`size` integer NOT NULL,
	`state` text NOT NULL,
	`message` text,
	`download_client_id` integer,
	`save_path` text,
	`added_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cross_seeds_info_hash_idx` ON `cross_seeds` (`info_hash`);--> statement-breakpoint
CREATE INDEX `cross_seeds_media_file_idx` ON `cross_seeds` (`media_file_id`);--> statement-breakpoint
CREATE TABLE `transcode_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_file_id` integer NOT NULL,
	`rule_id` integer,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`path` text NOT NULL,
	`command` text DEFAULT '' NOT NULL,
	`message` text,
	`queued_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`size_before` integer,
	`size_after` integer
);
--> statement-breakpoint
CREATE INDEX `transcode_jobs_status_idx` ON `transcode_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `transcode_jobs_file_idx` ON `transcode_jobs` (`media_file_id`);--> statement-breakpoint
CREATE TABLE `transcode_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`media_type` text NOT NULL,
	`scope` text NOT NULL,
	`conditions` text NOT NULL,
	`action` text NOT NULL,
	`options` text NOT NULL,
	`keep_original` integer DEFAULT false NOT NULL,
	`run_after_import` integer DEFAULT false NOT NULL,
	`schedule` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `media_files` ADD `version_tag` text;--> statement-breakpoint
CREATE UNIQUE INDEX `media_files_movie_version_idx` ON `media_files` (`movie_id`,`version_tag`);--> statement-breakpoint
ALTER TABLE `movies` ADD `versions` text;--> statement-breakpoint
ALTER TABLE `series` ADD `versions` text;--> statement-breakpoint
ALTER TABLE `subtitle_files` ADD `sync_score` integer;--> statement-breakpoint
ALTER TABLE `subtitle_files` ADD `sync_offset_ms` integer;--> statement-breakpoint
ALTER TABLE `subtitle_files` ADD `sync_drift_ppm` integer;--> statement-breakpoint
ALTER TABLE `subtitle_files` ADD `sync_checked_at` text;--> statement-breakpoint
ALTER TABLE `subtitle_files` ADD `sync_method` text;--> statement-breakpoint
ALTER TABLE `subtitle_history` ADD `sync_score` integer;--> statement-breakpoint
ALTER TABLE `subtitle_history` ADD `sync_offset_ms` integer;--> statement-breakpoint
ALTER TABLE `subtitle_history` ADD `sync_drift_ppm` integer;--> statement-breakpoint
ALTER TABLE `media_requests` ADD `estimated_size_bytes` integer;--> statement-breakpoint
ALTER TABLE `media_requests` ADD `policy_hold` text;