CREATE TABLE `history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`media_type` text NOT NULL,
	`series_id` integer,
	`episode_id` integer,
	`movie_id` integer,
	`source_title` text NOT NULL,
	`quality` text NOT NULL,
	`languages` text NOT NULL,
	`date` text NOT NULL,
	`download_id` text,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `history_download_id_idx` ON `history` (`download_id`);--> statement-breakpoint
CREATE INDEX `history_series_id_idx` ON `history` (`series_id`);--> statement-breakpoint
CREATE INDEX `history_episode_id_idx` ON `history` (`episode_id`);--> statement-breakpoint
CREATE INDEX `history_movie_id_idx` ON `history` (`movie_id`);--> statement-breakpoint
CREATE INDEX `history_event_type_idx` ON `history` (`event_type`);--> statement-breakpoint
CREATE INDEX `history_date_idx` ON `history` (`date`);--> statement-breakpoint
CREATE TABLE `blocklist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_type` text NOT NULL,
	`series_id` integer,
	`episode_ids` text NOT NULL,
	`movie_id` integer,
	`source_title` text NOT NULL,
	`quality` text NOT NULL,
	`languages` text NOT NULL,
	`date` text NOT NULL,
	`published_date` text,
	`size` integer,
	`protocol` text NOT NULL,
	`indexer` text,
	`indexer_flags` text NOT NULL,
	`message` text,
	`torrent_info_hash` text,
	`source` text,
	`release_type` text
);
--> statement-breakpoint
CREATE INDEX `blocklist_series_id_idx` ON `blocklist` (`series_id`);--> statement-breakpoint
CREATE INDEX `blocklist_movie_id_idx` ON `blocklist` (`movie_id`);--> statement-breakpoint
CREATE INDEX `blocklist_torrent_info_hash_idx` ON `blocklist` (`torrent_info_hash`);--> statement-breakpoint
CREATE INDEX `blocklist_date_idx` ON `blocklist` (`date`);--> statement-breakpoint
CREATE TABLE `pending_releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guid` text NOT NULL,
	`indexer_id` integer NOT NULL,
	`title` text NOT NULL,
	`media_type` text NOT NULL,
	`series_id` integer,
	`episode_ids` text,
	`movie_id` integer,
	`reason` text NOT NULL,
	`release` text NOT NULL,
	`added_at` text NOT NULL,
	`eligible_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_releases_guid_indexer_idx` ON `pending_releases` (`guid`,`indexer_id`);--> statement-breakpoint
CREATE INDEX `pending_releases_series_idx` ON `pending_releases` (`series_id`);--> statement-breakpoint
CREATE INDEX `pending_releases_movie_idx` ON `pending_releases` (`movie_id`);--> statement-breakpoint
CREATE TABLE `release_search_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_type` text NOT NULL,
	`item_id` integer NOT NULL,
	`last_searched_at` text NOT NULL,
	`search_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_search_state_item_idx` ON `release_search_state` (`media_type`,`item_id`);--> statement-breakpoint
CREATE TABLE `imported_downloads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`download_id` text NOT NULL,
	`media_type` text NOT NULL,
	`series_id` integer,
	`movie_id` integer,
	`episode_ids` text NOT NULL,
	`media_file_id` integer,
	`source_path` text NOT NULL,
	`destination_path` text NOT NULL,
	`imported_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `imported_downloads_download_idx` ON `imported_downloads` (`download_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`implementation` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`on_grab` integer DEFAULT false NOT NULL,
	`on_download` integer DEFAULT false NOT NULL,
	`on_upgrade` integer DEFAULT false NOT NULL,
	`on_rename` integer DEFAULT false NOT NULL,
	`on_series_add` integer DEFAULT false NOT NULL,
	`on_movie_add` integer DEFAULT false NOT NULL,
	`on_series_delete` integer DEFAULT false NOT NULL,
	`on_movie_delete` integer DEFAULT false NOT NULL,
	`on_file_delete` integer DEFAULT false NOT NULL,
	`on_health_issue` integer DEFAULT false NOT NULL,
	`on_health_restored` integer DEFAULT false NOT NULL,
	`on_application_update` integer DEFAULT false NOT NULL,
	`on_manual_interaction_required` integer DEFAULT false NOT NULL,
	`include_health_warnings` integer DEFAULT false NOT NULL,
	`tags` text NOT NULL,
	`settings` text NOT NULL,
	`added_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_name_unique` ON `notifications` (`name`);