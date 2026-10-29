CREATE TABLE `audio_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`foreign_id` text NOT NULL,
	`parent_foreign_id` text,
	`region` text,
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
CREATE INDEX `audio_requests_item_idx` ON `audio_requests` (`kind`,`foreign_id`);--> statement-breakpoint
CREATE INDEX `audio_requests_user_idx` ON `audio_requests` (`requested_by_id`);--> statement-breakpoint
CREATE INDEX `audio_requests_status_idx` ON `audio_requests` (`status`);