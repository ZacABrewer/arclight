CREATE TABLE `book_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`ebook_id` integer,
	`comic_issue_id` integer,
	`path` text NOT NULL,
	`relative_path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`format` text NOT NULL,
	`release_group` text,
	`scene_name` text,
	`date_added` text NOT NULL,
	FOREIGN KEY (`ebook_id`) REFERENCES `ebooks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`comic_issue_id`) REFERENCES `comic_issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_files_path_idx` ON `book_files` (`path`);--> statement-breakpoint
CREATE INDEX `book_files_ebook_idx` ON `book_files` (`ebook_id`);--> statement-breakpoint
CREATE INDEX `book_files_comic_issue_idx` ON `book_files` (`comic_issue_id`);--> statement-breakpoint
CREATE TABLE `book_format_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`formats` text NOT NULL,
	`cutoff` text NOT NULL,
	`upgrade_allowed` integer DEFAULT true NOT NULL,
	`min_size_mb` real,
	`max_size_mb` real,
	`ignored_terms` text NOT NULL,
	`preferred_terms` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_format_profiles_name_idx` ON `book_format_profiles` (`name`);--> statement-breakpoint
CREATE TABLE `book_grabs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`ebook_id` integer,
	`comic_issue_id` integer,
	`download_id` text NOT NULL,
	`guid` text NOT NULL,
	`indexer_id` integer NOT NULL,
	`indexer_name` text NOT NULL,
	`title` text NOT NULL,
	`protocol` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`format` text,
	`release_group` text,
	`status` text DEFAULT 'grabbed' NOT NULL,
	`message` text,
	`grabbed_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`ebook_id`) REFERENCES `ebooks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`comic_issue_id`) REFERENCES `comic_issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `book_grabs_download_id_idx` ON `book_grabs` (`download_id`);--> statement-breakpoint
CREATE INDEX `book_grabs_guid_idx` ON `book_grabs` (`guid`);--> statement-breakpoint
CREATE INDEX `book_grabs_ebook_idx` ON `book_grabs` (`ebook_id`);--> statement-breakpoint
CREATE INDEX `book_grabs_comic_issue_idx` ON `book_grabs` (`comic_issue_id`);--> statement-breakpoint
CREATE TABLE `book_library_apps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`implementation` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`url` text NOT NULL,
	`api_key` text DEFAULT '' NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`password` text DEFAULT '' NOT NULL,
	`library_id` text DEFAULT '' NOT NULL,
	`kinds` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `book_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`foreign_id` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`year` integer,
	`cover_url` text,
	`requested_by_id` integer NOT NULL,
	`modified_by_id` integer,
	`decline_reason` text,
	`failure_reason` text,
	`library_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `book_requests_kind_foreign_idx` ON `book_requests` (`kind`,`foreign_id`);--> statement-breakpoint
CREATE INDEX `book_requests_requested_by_idx` ON `book_requests` (`requested_by_id`);--> statement-breakpoint
CREATE INDEX `book_requests_status_idx` ON `book_requests` (`status`);--> statement-breakpoint
CREATE TABLE `comic_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` integer NOT NULL,
	`foreign_id` text,
	`comic_vine_id` text,
	`metron_id` text,
	`issue_number` text NOT NULL,
	`issue_key` text NOT NULL,
	`issue_sort` real,
	`title` text,
	`cover_date` text,
	`store_date` text,
	`overview` text DEFAULT '' NOT NULL,
	`cover_url` text,
	`monitored` integer DEFAULT true NOT NULL,
	`has_file` integer DEFAULT false NOT NULL,
	`last_searched_at` text,
	`added` text NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `comic_series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comic_issues_series_issue_idx` ON `comic_issues` (`series_id`,`issue_key`);--> statement-breakpoint
CREATE INDEX `comic_issues_monitored_has_file_idx` ON `comic_issues` (`monitored`,`has_file`);--> statement-breakpoint
CREATE INDEX `comic_issues_store_date_idx` ON `comic_issues` (`store_date`);--> statement-breakpoint
CREATE TABLE `comic_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`foreign_id` text NOT NULL,
	`comic_vine_id` text,
	`metron_id` text,
	`title` text NOT NULL,
	`sort_title` text NOT NULL,
	`clean_title` text NOT NULL,
	`publisher` text,
	`start_year` integer,
	`series_type` text DEFAULT 'comic' NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`cover_url` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`path` text NOT NULL,
	`root_folder_path` text NOT NULL,
	`format_profile_id` integer NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`monitor_new_issues` integer DEFAULT true NOT NULL,
	`tags` text NOT NULL,
	`added` text NOT NULL,
	`last_refreshed` text,
	`next_refresh_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comic_series_foreign_id_idx` ON `comic_series` (`foreign_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `comic_series_comic_vine_id_idx` ON `comic_series` (`comic_vine_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `comic_series_metron_id_idx` ON `comic_series` (`metron_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `comic_series_path_idx` ON `comic_series` (`path`);--> statement-breakpoint
CREATE INDEX `comic_series_clean_title_idx` ON `comic_series` (`clean_title`);--> statement-breakpoint
CREATE INDEX `comic_series_next_refresh_idx` ON `comic_series` (`next_refresh_at`);--> statement-breakpoint
CREATE TABLE `ebook_authors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`foreign_id` text NOT NULL,
	`ol_author_id` text,
	`hardcover_id` text,
	`name` text NOT NULL,
	`sort_name` text NOT NULL,
	`clean_name` text NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`image_url` text,
	`path` text NOT NULL,
	`root_folder_path` text NOT NULL,
	`format_profile_id` integer NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`monitor_new_books` text DEFAULT 'all' NOT NULL,
	`tags` text NOT NULL,
	`audiobook_author_id` integer,
	`added` text NOT NULL,
	`last_refreshed` text,
	`next_refresh_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ebook_authors_foreign_id_idx` ON `ebook_authors` (`foreign_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ebook_authors_ol_author_id_idx` ON `ebook_authors` (`ol_author_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ebook_authors_path_idx` ON `ebook_authors` (`path`);--> statement-breakpoint
CREATE INDEX `ebook_authors_clean_name_idx` ON `ebook_authors` (`clean_name`);--> statement-breakpoint
CREATE INDEX `ebook_authors_next_refresh_idx` ON `ebook_authors` (`next_refresh_at`);--> statement-breakpoint
CREATE TABLE `ebook_series_entries` (
	`series_id` integer NOT NULL,
	`ebook_id` integer NOT NULL,
	`position` text,
	`position_sort` real,
	PRIMARY KEY(`series_id`, `ebook_id`),
	FOREIGN KEY (`series_id`) REFERENCES `book_series`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ebook_id`) REFERENCES `ebooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ebook_series_entries_ebook_idx` ON `ebook_series_entries` (`ebook_id`);--> statement-breakpoint
CREATE TABLE `ebooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer NOT NULL,
	`foreign_id` text NOT NULL,
	`keys` text NOT NULL,
	`isbn13` text,
	`isbns` text NOT NULL,
	`ol_work_id` text,
	`google_volume_id` text,
	`hardcover_id` text,
	`title` text NOT NULL,
	`subtitle` text,
	`sort_title` text NOT NULL,
	`clean_title` text NOT NULL,
	`publisher` text,
	`language` text,
	`release_date` text,
	`year` integer,
	`page_count` integer,
	`overview` text DEFAULT '' NOT NULL,
	`genres` text NOT NULL,
	`cover_url` text,
	`rating` real,
	`monitored` integer DEFAULT true NOT NULL,
	`has_file` integer DEFAULT false NOT NULL,
	`last_searched_at` text,
	`added` text NOT NULL,
	`last_refreshed` text,
	FOREIGN KEY (`author_id`) REFERENCES `ebook_authors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ebooks_author_idx` ON `ebooks` (`author_id`);--> statement-breakpoint
CREATE INDEX `ebooks_foreign_id_idx` ON `ebooks` (`foreign_id`);--> statement-breakpoint
CREATE INDEX `ebooks_clean_title_idx` ON `ebooks` (`clean_title`);--> statement-breakpoint
CREATE INDEX `ebooks_isbn13_idx` ON `ebooks` (`isbn13`);--> statement-breakpoint
CREATE INDEX `ebooks_monitored_has_file_idx` ON `ebooks` (`monitored`,`has_file`);--> statement-breakpoint
CREATE INDEX `ebooks_release_date_idx` ON `ebooks` (`release_date`);