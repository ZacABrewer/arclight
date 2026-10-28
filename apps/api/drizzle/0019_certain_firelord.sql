CREATE TABLE `authors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asin` text,
	`ol_author_id` text,
	`name` text NOT NULL,
	`sort_name` text NOT NULL,
	`clean_name` text NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`images` text NOT NULL,
	`genres` text NOT NULL,
	`aliases` text NOT NULL,
	`path` text NOT NULL,
	`root_folder_path` text NOT NULL,
	`quality_profile_id` integer NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`monitor_new_books` text DEFAULT 'all' NOT NULL,
	`languages` text NOT NULL,
	`tags` text NOT NULL,
	`added` text NOT NULL,
	`last_refreshed` text,
	`next_refresh_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `authors_asin_idx` ON `authors` (`asin`);--> statement-breakpoint
CREATE UNIQUE INDEX `authors_ol_author_id_idx` ON `authors` (`ol_author_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `authors_path_idx` ON `authors` (`path`);--> statement-breakpoint
CREATE INDEX `authors_clean_name_idx` ON `authors` (`clean_name`);--> statement-breakpoint
CREATE INDEX `authors_next_refresh_idx` ON `authors` (`next_refresh_at`);--> statement-breakpoint
CREATE TABLE `book_authors` (
	`book_id` integer NOT NULL,
	`author_id` integer NOT NULL,
	`role` text DEFAULT 'author' NOT NULL,
	PRIMARY KEY(`book_id`, `author_id`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `book_authors_author_idx` ON `book_authors` (`author_id`);--> statement-breakpoint
CREATE TABLE `book_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asin` text,
	`name` text NOT NULL,
	`clean_name` text NOT NULL,
	`overview` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_series_asin_idx` ON `book_series` (`asin`);--> statement-breakpoint
CREATE INDEX `book_series_clean_name_idx` ON `book_series` (`clean_name`);--> statement-breakpoint
CREATE TABLE `book_series_entries` (
	`series_id` integer NOT NULL,
	`book_id` integer NOT NULL,
	`position` text,
	`position_sort` real,
	`is_primary` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`series_id`, `book_id`),
	FOREIGN KEY (`series_id`) REFERENCES `book_series`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `book_series_entries_book_idx` ON `book_series_entries` (`book_id`);--> statement-breakpoint
CREATE TABLE `books` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer NOT NULL,
	`asin` text,
	`isbn13` text,
	`ol_work_id` text,
	`region` text,
	`title` text NOT NULL,
	`subtitle` text,
	`sort_title` text NOT NULL,
	`clean_title` text NOT NULL,
	`author_credits` text NOT NULL,
	`narrators` text NOT NULL,
	`publisher` text,
	`language` text,
	`release_date` text,
	`year` integer,
	`runtime_minutes` integer,
	`format_type` text,
	`overview` text DEFAULT '' NOT NULL,
	`genres` text NOT NULL,
	`images` text NOT NULL,
	`chapters` text NOT NULL,
	`ratings` text NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`has_file` integer DEFAULT false NOT NULL,
	`path` text,
	`added` text NOT NULL,
	`last_refreshed` text,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `books_asin_idx` ON `books` (`asin`);--> statement-breakpoint
CREATE INDEX `books_author_idx` ON `books` (`author_id`);--> statement-breakpoint
CREATE INDEX `books_monitored_has_file_idx` ON `books` (`monitored`,`has_file`);--> statement-breakpoint
CREATE INDEX `books_release_date_idx` ON `books` (`release_date`);--> statement-breakpoint
CREATE INDEX `books_clean_title_idx` ON `books` (`clean_title`);--> statement-breakpoint
CREATE INDEX `books_isbn13_idx` ON `books` (`isbn13`);