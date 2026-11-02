CREATE TABLE `newsletter_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sent_at` text NOT NULL,
	`trigger` text NOT NULL,
	`recipients` integer DEFAULT 0 NOT NULL,
	`items` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `wrapped_shares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`user_id` integer NOT NULL,
	`year` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wrapped_shares_token_idx` ON `wrapped_shares` (`token`);--> statement-breakpoint
CREATE INDEX `wrapped_shares_user_idx` ON `wrapped_shares` (`user_id`);--> statement-breakpoint
CREATE TABLE `collection_syncs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_key` text NOT NULL,
	`server_id` text NOT NULL,
	`remote_id` text,
	`name` text NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`missing` integer DEFAULT 0 NOT NULL,
	`last_sync_at` text,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_syncs_key_server_idx` ON `collection_syncs` (`collection_key`,`server_id`);--> statement-breakpoint
CREATE TABLE `smart_collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`media_type` text NOT NULL,
	`criteria` text NOT NULL,
	`sort` text NOT NULL,
	`limit` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
