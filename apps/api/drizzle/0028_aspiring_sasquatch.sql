ALTER TABLE `tracked_downloads` ADD `safety_checked_at` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_download_rejected` integer DEFAULT false NOT NULL;