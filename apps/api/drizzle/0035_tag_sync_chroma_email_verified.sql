CREATE TABLE `media_server_tag_sync_state` (
	`server_id` text PRIMARY KEY NOT NULL,
	`last_run_at` text,
	`last_changed` integer DEFAULT 0 NOT NULL,
	`last_unmatched` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `media_server_tag_syncs` (
	`server_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`remote_item_id` text NOT NULL,
	`label` text NOT NULL,
	`preexisting` integer DEFAULT false NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `remote_item_id`, `label`)
);
--> statement-breakpoint
CREATE INDEX `media_server_tag_syncs_entity_idx` ON `media_server_tag_syncs` (`server_id`,`entity_type`,`entity_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `video_fingerprints` ADD `chroma` blob;