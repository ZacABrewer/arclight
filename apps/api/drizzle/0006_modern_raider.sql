CREATE TABLE `indexer_proxies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`username` text,
	`password` text,
	`request_timeout` integer,
	`tags` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `indexer_proxies_name_unique` ON `indexer_proxies` (`name`);--> statement-breakpoint
CREATE TABLE `indexer_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`indexer_id` integer NOT NULL,
	`kind` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`success` integer NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`indexer_id`) REFERENCES `indexers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `indexer_stats_at_idx` ON `indexer_stats` (`at`);--> statement-breakpoint
CREATE INDEX `indexer_stats_indexer_idx` ON `indexer_stats` (`indexer_id`);--> statement-breakpoint
CREATE TABLE `migrate_imported` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance` text NOT NULL,
	`source_app` text NOT NULL,
	`area` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` integer,
	`imported_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `migrate_imported_key_idx` ON `migrate_imported` (`instance`,`area`,`source_id`);--> statement-breakpoint
CREATE INDEX `migrate_imported_area_idx` ON `migrate_imported` (`area`);--> statement-breakpoint
CREATE TABLE `migrate_staging` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`area` text NOT NULL,
	`source_app` text NOT NULL,
	`source_id` text NOT NULL,
	`payload` text NOT NULL,
	`staged_at` text NOT NULL,
	`consumed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `migrate_staging_key_idx` ON `migrate_staging` (`area`,`source_app`,`source_id`);--> statement-breakpoint
CREATE INDEX `migrate_staging_area_idx` ON `migrate_staging` (`area`,`consumed_at`);--> statement-breakpoint
CREATE TABLE `language_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`languages` text NOT NULL,
	`cutoff` text,
	`must_contain` text NOT NULL,
	`must_not_contain` text NOT NULL,
	`original_format` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subtitle_blacklist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`provider_subtitle_id` text NOT NULL,
	`language` text NOT NULL,
	`forced` integer DEFAULT false NOT NULL,
	`hi` integer DEFAULT false NOT NULL,
	`media_type` text NOT NULL,
	`series_id` integer,
	`movie_id` integer,
	`media_file_id` integer,
	`title` text NOT NULL,
	`date` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subtitle_blacklist_provider_id_idx` ON `subtitle_blacklist` (`provider`,`provider_subtitle_id`);--> statement-breakpoint
CREATE TABLE `subtitle_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_file_id` integer NOT NULL,
	`language` text NOT NULL,
	`forced` integer DEFAULT false NOT NULL,
	`hi` integer DEFAULT false NOT NULL,
	`path` text,
	`embedded` integer DEFAULT false NOT NULL,
	`stream_index` integer,
	`codec` text,
	`provider` text,
	`provider_subtitle_id` text,
	`score` integer,
	`score_out_of` integer,
	`size` integer,
	`mtime` text,
	`added` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subtitle_files_media_file_idx` ON `subtitle_files` (`media_file_id`);--> statement-breakpoint
CREATE INDEX `subtitle_files_path_idx` ON `subtitle_files` (`path`);--> statement-breakpoint
CREATE TABLE `subtitle_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`description` text NOT NULL,
	`language` text NOT NULL,
	`forced` integer DEFAULT false NOT NULL,
	`hi` integer DEFAULT false NOT NULL,
	`provider` text,
	`provider_subtitle_id` text,
	`score` integer,
	`score_out_of` integer,
	`media_type` text NOT NULL,
	`series_id` integer,
	`movie_id` integer,
	`episode_ids` text NOT NULL,
	`media_file_id` integer,
	`title` text NOT NULL,
	`subtitle_path` text,
	`video_path` text NOT NULL,
	`matched` text NOT NULL,
	`not_matched` text NOT NULL,
	`upgraded_from_id` integer,
	`date` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subtitle_history_date_idx` ON `subtitle_history` (`date`);--> statement-breakpoint
CREATE INDEX `subtitle_history_media_file_idx` ON `subtitle_history` (`media_file_id`);--> statement-breakpoint
CREATE INDEX `subtitle_history_video_path_idx` ON `subtitle_history` (`video_path`);--> statement-breakpoint
CREATE TABLE `subtitle_provider_state` (
	`provider` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`description` text NOT NULL,
	`until` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subtitle_wanted_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_file_id` integer NOT NULL,
	`language` text NOT NULL,
	`first_attempt` text NOT NULL,
	`last_attempt` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subtitle_wanted_state_file_lang_idx` ON `subtitle_wanted_state` (`media_file_id`,`language`);--> statement-breakpoint
CREATE TABLE `discover_sliders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`sort_order` integer NOT NULL,
	`is_built_in` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`title` text,
	`data` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `issue_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_comments_issue_idx` ON `issue_comments` (`issue_id`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`poster` text,
	`problem_season` integer DEFAULT 0 NOT NULL,
	`problem_episode` integer DEFAULT 0 NOT NULL,
	`created_by_id` integer NOT NULL,
	`modified_by_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `issues_media_idx` ON `issues` (`media_type`,`tmdb_id`);--> statement-breakpoint
CREATE INDEX `issues_created_by_idx` ON `issues` (`created_by_id`);--> statement-breakpoint
CREATE TABLE `media_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`is_4k` integer DEFAULT false NOT NULL,
	`tmdb_id` integer NOT NULL,
	`tvdb_id` integer,
	`title` text NOT NULL,
	`year` integer,
	`poster` text,
	`backdrop` text,
	`requested_by_id` integer NOT NULL,
	`modified_by_id` integer,
	`root_folder_path` text,
	`quality_profile_id` integer,
	`tags` text NOT NULL,
	`ignore_quota` integer DEFAULT false NOT NULL,
	`is_auto_request` integer DEFAULT false NOT NULL,
	`decline_reason` text,
	`failure_reason` text,
	`library_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_requests_media_idx` ON `media_requests` (`type`,`tmdb_id`);--> statement-breakpoint
CREATE INDEX `media_requests_user_idx` ON `media_requests` (`requested_by_id`);--> statement-breakpoint
CREATE INDEX `media_requests_status_idx` ON `media_requests` (`status`);--> statement-breakpoint
CREATE TABLE `override_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`media_type` text NOT NULL,
	`is_4k` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`users` text NOT NULL,
	`genres` text NOT NULL,
	`languages` text NOT NULL,
	`keywords` text NOT NULL,
	`quality_profile_id` integer,
	`root_folder_path` text,
	`tags` text NOT NULL,
	`auto_approve` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_media_status` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`status` text NOT NULL,
	`status_4k` text NOT NULL,
	`seasons` text NOT NULL,
	`library_id` integer,
	`last_synced_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `request_media_status_media_idx` ON `request_media_status` (`media_type`,`tmdb_id`);--> statement-breakpoint
CREATE TABLE `season_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `media_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `season_requests_request_season_idx` ON `season_requests` (`request_id`,`season_number`);--> statement-breakpoint
CREATE TABLE `watchlist_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`poster` text,
	`source` text NOT NULL,
	`external_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_items_user_media_idx` ON `watchlist_items` (`user_id`,`media_type`,`tmdb_id`);--> statement-breakpoint
ALTER TABLE `movies` ADD `language_profile_id` integer;--> statement-breakpoint
ALTER TABLE `series` ADD `language_profile_id` integer;--> statement-breakpoint
ALTER TABLE `indexers` ADD `proxy_id` integer;