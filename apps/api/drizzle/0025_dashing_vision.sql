CREATE TABLE `language_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`media_type` text NOT NULL,
	`movie_id` integer,
	`series_id` integer,
	`season_number` integer,
	`tmdb_id` integer NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`poster` text,
	`language` text NOT NULL,
	`forced` text DEFAULT 'never' NOT NULL,
	`hi` text DEFAULT 'also' NOT NULL,
	`mode` text,
	`note` text,
	`requested_by_id` integer NOT NULL,
	`modified_by_id` integer,
	`decline_reason` text,
	`failure_reason` text,
	`outcome` text,
	`outcome_message` text,
	`additional_language_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `language_requests_movie_idx` ON `language_requests` (`movie_id`);--> statement-breakpoint
CREATE INDEX `language_requests_series_idx` ON `language_requests` (`series_id`);--> statement-breakpoint
CREATE INDEX `language_requests_user_idx` ON `language_requests` (`requested_by_id`);--> statement-breakpoint
CREATE INDEX `language_requests_status_idx` ON `language_requests` (`status`);