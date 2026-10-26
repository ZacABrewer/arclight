CREATE TABLE `profile_file_fits` (
	`media_file_id` integer PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`series_id` integer,
	`movie_id` integer,
	`slot` text DEFAULT '' NOT NULL,
	`quality_profile_id` integer NOT NULL,
	`status` text NOT NULL,
	`reasons` text NOT NULL,
	`quality_name` text NOT NULL,
	`format_score` integer NOT NULL,
	`evaluated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `profile_file_fits_profile_status_idx` ON `profile_file_fits` (`quality_profile_id`,`status`);--> statement-breakpoint
CREATE INDEX `profile_file_fits_series_idx` ON `profile_file_fits` (`series_id`);--> statement-breakpoint
CREATE INDEX `profile_file_fits_movie_idx` ON `profile_file_fits` (`movie_id`);--> statement-breakpoint
CREATE TABLE `profile_item_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_type` text NOT NULL,
	`item_id` integer NOT NULL,
	`profiles` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_item_snapshots_item_idx` ON `profile_item_snapshots` (`media_type`,`item_id`);--> statement-breakpoint
CREATE TABLE `profile_migration_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`unit_key` text NOT NULL,
	`media_type` text NOT NULL,
	`series_id` integer,
	`season_number` integer,
	`episode_id` integer,
	`movie_id` integer,
	`slot` text DEFAULT '' NOT NULL,
	`quality_profile_id` integer NOT NULL,
	`media_file_id` integer NOT NULL,
	`file_status` text NOT NULL,
	`old_quality_name` text NOT NULL,
	`old_path` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`item_added` text NOT NULL,
	`last_searched_at` text,
	`next_search_at` text,
	`grabbed_at` text,
	`finished_at` text,
	`message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_migration_queue_unit_idx` ON `profile_migration_queue` (`unit_key`);--> statement-breakpoint
CREATE INDEX `profile_migration_queue_profile_state_idx` ON `profile_migration_queue` (`quality_profile_id`,`state`);--> statement-breakpoint
CREATE INDEX `profile_migration_queue_series_idx` ON `profile_migration_queue` (`series_id`);--> statement-breakpoint
CREATE INDEX `profile_migration_queue_movie_idx` ON `profile_migration_queue` (`movie_id`);--> statement-breakpoint
CREATE TABLE `profile_migration_rules` (
	`quality_profile_id` integer PRIMARY KEY NOT NULL,
	`mismatch_action` text DEFAULT 'none' NOT NULL,
	`auto_enabled` integer DEFAULT false NOT NULL,
	`paused` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profile_migration_searches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`quality_profile_id` integer NOT NULL,
	`automatic` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `profile_migration_searches_at_idx` ON `profile_migration_searches` (`at`);