CREATE TABLE `import_list_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_list_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`imdb_id` text,
	`title` text NOT NULL,
	`year` integer,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`import_list_id`) REFERENCES `import_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_list_items_list_media_tmdb_idx` ON `import_list_items` (`import_list_id`,`media_type`,`tmdb_id`);--> statement-breakpoint
CREATE INDEX `import_list_items_media_tmdb_idx` ON `import_list_items` (`media_type`,`tmdb_id`);--> statement-breakpoint
CREATE TABLE `import_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`implementation` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`enable_automatic_add` integer DEFAULT true NOT NULL,
	`search_on_add` integer DEFAULT false NOT NULL,
	`monitor_option` text DEFAULT 'all' NOT NULL,
	`series_type` text DEFAULT 'standard' NOT NULL,
	`season_folder` integer DEFAULT true NOT NULL,
	`root_folder_path` text NOT NULL,
	`movie_root_folder_path` text,
	`quality_profile_id` integer NOT NULL,
	`tags` text NOT NULL,
	`minimum_availability` text DEFAULT 'released' NOT NULL,
	`media_type` text NOT NULL,
	`settings` text NOT NULL,
	`last_sync_at` text,
	`last_sync_error` text,
	`added_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_lists_name_unique` ON `import_lists` (`name`);