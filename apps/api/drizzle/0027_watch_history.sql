CREATE TABLE `plugin_api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`purpose` text DEFAULT 'jellyfin-plugin' NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`last_ping_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_api_keys_hash_idx` ON `plugin_api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `media_server_sync_state` (
	`server_id` text PRIMARY KEY NOT NULL,
	`last_sync_at` text,
	`last_full_sync_at` text,
	`last_status` text,
	`last_error` text,
	`last_user_sync_at` text,
	`last_user_sync_status` text,
	`last_user_sync_error` text,
	`last_event_at` text
);
--> statement-breakpoint
CREATE TABLE `media_server_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`last_activity_at` text,
	`first_seen_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_watch_sync_at` text,
	`last_full_sync_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_server_users_server_external_idx` ON `media_server_users` (`server_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `watch_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`media_server_user_id` integer,
	`type` text NOT NULL,
	`at` text NOT NULL,
	`item_type` text NOT NULL,
	`item_key` text NOT NULL,
	`jellyfin_item_id` text,
	`title` text NOT NULL,
	`series_title` text,
	`season_number` integer,
	`episode_number` integer,
	`movie_id` integer,
	`series_id` integer,
	`episode_id` integer,
	`tmdb_id` integer,
	`position_ms` integer,
	`duration_ms` integer,
	`client` text,
	`device` text,
	`play_method` text,
	`session_id` text,
	`source` text NOT NULL,
	`dedupe_key` text NOT NULL,
	FOREIGN KEY (`media_server_user_id`) REFERENCES `media_server_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watch_events_dedupe_idx` ON `watch_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `watch_events_at_idx` ON `watch_events` (`at`);--> statement-breakpoint
CREATE INDEX `watch_events_user_at_idx` ON `watch_events` (`media_server_user_id`,`at`);--> statement-breakpoint
CREATE INDEX `watch_events_session_idx` ON `watch_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `watch_events_movie_idx` ON `watch_events` (`movie_id`);--> statement-breakpoint
CREATE INDEX `watch_events_series_idx` ON `watch_events` (`series_id`);--> statement-breakpoint
CREATE TABLE `watch_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`media_server_user_id` integer NOT NULL,
	`jellyfin_item_id` text NOT NULL,
	`item_type` text NOT NULL,
	`item_key` text NOT NULL,
	`movie_id` integer,
	`series_id` integer,
	`episode_id` integer,
	`season_number` integer,
	`episode_number` integer,
	`tmdb_id` integer,
	`tvdb_id` integer,
	`imdb_id` text,
	`jellyfin_series_id` text,
	`jellyfin_season_id` text,
	`title` text NOT NULL,
	`played` integer DEFAULT false NOT NULL,
	`play_count` integer DEFAULT 0 NOT NULL,
	`last_played_at` text,
	`position_ms` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`favorite` integer DEFAULT false NOT NULL,
	`episodes_total` integer,
	`episodes_played` integer,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`media_server_user_id`) REFERENCES `media_server_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watch_state_user_item_idx` ON `watch_state` (`media_server_user_id`,`jellyfin_item_id`);--> statement-breakpoint
CREATE INDEX `watch_state_item_key_idx` ON `watch_state` (`item_key`);--> statement-breakpoint
CREATE INDEX `watch_state_movie_idx` ON `watch_state` (`movie_id`);--> statement-breakpoint
CREATE INDEX `watch_state_series_idx` ON `watch_state` (`series_id`);--> statement-breakpoint
CREATE INDEX `watch_state_server_idx` ON `watch_state` (`server_id`);--> statement-breakpoint
CREATE INDEX `watch_state_jf_series_idx` ON `watch_state` (`media_server_user_id`,`jellyfin_series_id`);--> statement-breakpoint
ALTER TABLE `retention_rules` ADD `keep_if_requester_has_not_watched` integer DEFAULT false NOT NULL;