CREATE TABLE `import_list_additions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_list_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`added_at` text NOT NULL,
	FOREIGN KEY (`import_list_id`) REFERENCES `import_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_list_additions_list_media_tmdb_idx` ON `import_list_additions` (`import_list_id`,`media_type`,`tmdb_id`);--> statement-breakpoint
CREATE TABLE `import_list_id_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`media_type` text,
	`tmdb_id` integer,
	`imdb_id` text,
	`title` text,
	`year` integer,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_list_id_cache_ns_key_idx` ON `import_list_id_cache` (`namespace`,`key`);--> statement-breakpoint
ALTER TABLE `import_lists` ADD `sync_interval_hours` integer;--> statement-breakpoint
ALTER TABLE `import_lists` ADD `filters` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `import_lists` ADD `streaming` text DEFAULT '{"enabled":false,"providerIds":[]}' NOT NULL;--> statement-breakpoint
ALTER TABLE `import_lists` ADD `cleanup_action` text DEFAULT 'none' NOT NULL;