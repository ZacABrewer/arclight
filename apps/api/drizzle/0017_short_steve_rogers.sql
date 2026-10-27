CREATE TABLE `release_search_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_type` text NOT NULL,
	`item_id` integer NOT NULL,
	`searched_at` text NOT NULL,
	`source` text NOT NULL,
	`outcome` text NOT NULL,
	`releases` integer DEFAULT 0 NOT NULL,
	`approved` integer DEFAULT 0 NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_search_results_item_idx` ON `release_search_results` (`media_type`,`item_id`);