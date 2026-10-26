CREATE TABLE `indexer_caps_cache` (
	`indexer_id` integer PRIMARY KEY NOT NULL,
	`caps` text NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`indexer_id`) REFERENCES `indexers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `indexer_rss_state` (
	`indexer_id` integer PRIMARY KEY NOT NULL,
	`last_guid` text,
	`last_publish_date` text,
	`recent_guids` text NOT NULL,
	`last_sync_at` text NOT NULL,
	FOREIGN KEY (`indexer_id`) REFERENCES `indexers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `indexer_status` (
	`indexer_id` integer PRIMARY KEY NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`initial_failure` text,
	`last_failure` text,
	`disabled_till` text,
	`most_recent_failure` text,
	FOREIGN KEY (`indexer_id`) REFERENCES `indexers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `indexers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`implementation` text NOT NULL,
	`enable_rss` integer DEFAULT true NOT NULL,
	`enable_automatic_search` integer DEFAULT true NOT NULL,
	`enable_interactive_search` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 25 NOT NULL,
	`download_client_id` integer,
	`tags` text NOT NULL,
	`settings` text NOT NULL,
	`added_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `indexers_name_unique` ON `indexers` (`name`);--> statement-breakpoint
CREATE TABLE `download_clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`implementation` text NOT NULL,
	`enable` integer DEFAULT true NOT NULL,
	`protocol` text NOT NULL,
	`priority` integer DEFAULT 1 NOT NULL,
	`remove_completed_downloads` integer DEFAULT true NOT NULL,
	`remove_failed_downloads` integer DEFAULT true NOT NULL,
	`tags` text NOT NULL,
	`settings` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `download_clients_name_unique` ON `download_clients` (`name`);--> statement-breakpoint
CREATE TABLE `remote_path_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host` text NOT NULL,
	`remote_path` text NOT NULL,
	`local_path` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_path_mappings_host_remote_idx` ON `remote_path_mappings` (`host`,`remote_path`);--> statement-breakpoint
CREATE TABLE `tracked_downloads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`download_id` text NOT NULL,
	`client_id` integer,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`tracked_status` text DEFAULT 'ok' NOT NULL,
	`client_status` text DEFAULT 'unknown' NOT NULL,
	`status_messages` text NOT NULL,
	`protocol` text NOT NULL,
	`category` text,
	`size` integer DEFAULT 0 NOT NULL,
	`size_left` integer DEFAULT 0 NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`eta_ms` integer,
	`output_path` text,
	`can_move_files` integer DEFAULT false NOT NULL,
	`can_be_removed` integer DEFAULT false NOT NULL,
	`is_read_only` integer DEFAULT true NOT NULL,
	`added_at` text NOT NULL,
	`last_seen_at` text,
	`updated_at` text NOT NULL,
	`media_type` text,
	`series_id` integer,
	`episode_ids` text,
	`movie_id` integer,
	`grabbed_release` text,
	`pending_grab` text,
	FOREIGN KEY (`client_id`) REFERENCES `download_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracked_downloads_client_download_idx` ON `tracked_downloads` (`client_id`,`download_id`);--> statement-breakpoint
CREATE INDEX `tracked_downloads_state_idx` ON `tracked_downloads` (`state`);