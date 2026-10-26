CREATE TABLE `additional_languages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`media_type` text NOT NULL,
	`movie_id` integer,
	`series_id` integer,
	`season_number` integer,
	`episode_id` integer,
	`scope_key` text NOT NULL,
	`language` text NOT NULL,
	`forced` text DEFAULT 'never' NOT NULL,
	`hi` text DEFAULT 'also' NOT NULL,
	`mode` text,
	`version_tag` text,
	`status` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `additional_languages_scope_idx` ON `additional_languages` (`kind`,`scope_key`,`language`);--> statement-breakpoint
CREATE INDEX `additional_languages_series_idx` ON `additional_languages` (`series_id`);--> statement-breakpoint
CREATE INDEX `additional_languages_movie_idx` ON `additional_languages` (`movie_id`);