CREATE TABLE `guides_cache` (
	`url` text PRIMARY KEY NOT NULL,
	`etag` text,
	`sha` text,
	`body` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `guides_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_sync_at` text,
	`last_success_at` text,
	`last_error` text,
	`last_applied_at` text,
	`pending_diff` text,
	`pending_since` text,
	`notified_revision` text,
	`last_fetch` text
);
--> statement-breakpoint
CREATE TABLE `retention_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`media_id` integer NOT NULL,
	`tmdb_id` integer NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`action` text NOT NULL,
	`reasons` text NOT NULL,
	`watched_by` text NOT NULL,
	`status` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`apply_after` text NOT NULL,
	`applied_at` text,
	`kept_at` text,
	`error` text,
	FOREIGN KEY (`rule_id`) REFERENCES `retention_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retention_candidates_rule_media_idx` ON `retention_candidates` (`rule_id`,`media_type`,`media_id`);--> statement-breakpoint
CREATE INDEX `retention_candidates_status_idx` ON `retention_candidates` (`status`);--> statement-breakpoint
CREATE TABLE `retention_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`media_type` text NOT NULL,
	`scope` text NOT NULL,
	`conditions` text NOT NULL,
	`grace_days` integer DEFAULT 7 NOT NULL,
	`action` text NOT NULL,
	`add_exclusion` integer DEFAULT false NOT NULL,
	`keep_if_requested_within_days` integer,
	`keep_if_in_collection` integer DEFAULT false NOT NULL,
	`dry_run` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_analysis_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_file_id` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`queued_at` text NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_analysis_jobs_file_idx` ON `media_analysis_jobs` (`media_file_id`);--> statement-breakpoint
CREATE INDEX `media_analysis_jobs_status_idx` ON `media_analysis_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `library_hygiene_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`path` text NOT NULL,
	`root_folder_path` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`media_file_id` integer,
	`series_id` integer,
	`movie_id` integer,
	`duplicate_reason` text,
	`duplicate_of` text NOT NULL,
	`parsed` text,
	`suggestions` text NOT NULL,
	`found_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `library_hygiene_findings_type_idx` ON `library_hygiene_findings` (`type`);--> statement-breakpoint
CREATE TABLE `stats_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`root_folder_path` text NOT NULL,
	`total_bytes` integer,
	`free_bytes` integer,
	`used_bytes` integer NOT NULL,
	`file_count` integer NOT NULL,
	`taken_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stats_snapshots_date_root_idx` ON `stats_snapshots` (`date`,`root_folder_path`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_idx` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`time` text NOT NULL,
	`user_id` integer,
	`username` text,
	`ip` text,
	`action` text NOT NULL,
	`target` text,
	`method` text,
	`route` text,
	`status_code` integer,
	`details` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_time_idx` ON `audit_events` (`time`);--> statement-breakpoint
CREATE INDEX `audit_events_action_idx` ON `audit_events` (`action`);--> statement-breakpoint
CREATE INDEX `audit_events_user_idx` ON `audit_events` (`user_id`);--> statement-breakpoint
ALTER TABLE `custom_formats` ADD `guide_id` text;--> statement-breakpoint
CREATE INDEX `custom_formats_guide_id_idx` ON `custom_formats` (`guide_id`);--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_request_created` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_request_approved` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_request_declined` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_request_available` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_issue_created` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_issue_updated` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `request_media_status` ADD `available_on` text;