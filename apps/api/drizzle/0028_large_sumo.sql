CREATE TABLE `podcast_episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`podcast_id` integer NOT NULL,
	`guid` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`published_at` text,
	`duration_seconds` integer,
	`season` integer,
	`episode_number` integer,
	`episode_type` text DEFAULT 'full' NOT NULL,
	`explicit` integer DEFAULT false NOT NULL,
	`image_url` text,
	`link` text,
	`enclosure` text,
	`alternate_enclosures` text NOT NULL,
	`chapters_url` text,
	`transcripts` text NOT NULL,
	`persons` text NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`path` text,
	`size_bytes` integer,
	`downloaded_at` text,
	`has_chapters` integer DEFAULT false NOT NULL,
	`transcript_files` text NOT NULL,
	`played` integer DEFAULT false NOT NULL,
	`played_at` text,
	`played_source` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`added` text NOT NULL,
	FOREIGN KEY (`podcast_id`) REFERENCES `podcasts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `podcast_episodes_guid_idx` ON `podcast_episodes` (`podcast_id`,`guid`);--> statement-breakpoint
CREATE INDEX `podcast_episodes_status_idx` ON `podcast_episodes` (`status`);--> statement-breakpoint
CREATE INDEX `podcast_episodes_published_idx` ON `podcast_episodes` (`published_at`);--> statement-breakpoint
CREATE TABLE `podcast_suggestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`feed_url` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`image_url` text,
	`itunes_id` integer,
	`podcast_index_id` integer,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`podcast_id` integer,
	`decline_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`podcast_id`) REFERENCES `podcasts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `podcast_suggestions_user_idx` ON `podcast_suggestions` (`user_id`);--> statement-breakpoint
CREATE INDEX `podcast_suggestions_status_idx` ON `podcast_suggestions` (`status`);--> statement-breakpoint
CREATE TABLE `podcasts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`sort_title` text NOT NULL,
	`author` text,
	`description` text DEFAULT '' NOT NULL,
	`feed_url` text NOT NULL,
	`link` text,
	`image_url` text,
	`language` text,
	`categories` text NOT NULL,
	`explicit` integer DEFAULT false NOT NULL,
	`feed_type` text DEFAULT 'episodic' NOT NULL,
	`podcast_guid` text,
	`itunes_id` integer,
	`podcast_index_id` integer,
	`funding` text NOT NULL,
	`path` text NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`settings` text NOT NULL,
	`tags` text NOT NULL,
	`etag` text,
	`last_modified` text,
	`ttl_minutes` integer,
	`added` text NOT NULL,
	`last_refreshed` text,
	`next_refresh_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `podcasts_feed_url_idx` ON `podcasts` (`feed_url`);--> statement-breakpoint
CREATE INDEX `podcasts_next_refresh_idx` ON `podcasts` (`next_refresh_at`);--> statement-breakpoint
CREATE INDEX `podcasts_guid_idx` ON `podcasts` (`podcast_guid`);--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_podcast_episodes` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_podcast_download` integer DEFAULT false NOT NULL;