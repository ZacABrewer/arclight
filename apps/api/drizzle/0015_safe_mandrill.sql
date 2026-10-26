CREATE TABLE `migrate_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state` text NOT NULL,
	`dry_run` integer NOT NULL,
	`request` text NOT NULL,
	`sources` text NOT NULL,
	`backup` text,
	`log` text NOT NULL,
	`error` text,
	`started_at` text NOT NULL,
	`ended_at` text
);
