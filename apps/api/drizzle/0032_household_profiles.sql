CREATE TABLE `household_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`initial` text NOT NULL,
	`is_owner` integer DEFAULT false NOT NULL,
	`pin_hash` text,
	`content_restrictions` text,
	`settings` text DEFAULT '{}' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `household_profiles_user_idx` ON `household_profiles` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `household_profiles_owner_idx` ON `household_profiles` (`user_id`) WHERE "household_profiles"."is_owner" = 1;--> statement-breakpoint
CREATE TABLE `profile_my_list` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`item_key` text NOT NULL,
	`added_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `household_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_my_list_item_idx` ON `profile_my_list` (`profile_id`,`item_key`);--> statement-breakpoint
CREATE TABLE `profile_playback_queue` (
	`profile_id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`queue` text NOT NULL,
	`device_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `household_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `playback_progress_user_item_idx`;--> statement-breakpoint
ALTER TABLE `playback_progress` ADD `profile_id` integer REFERENCES household_profiles(id);--> statement-breakpoint
CREATE UNIQUE INDEX `playback_progress_profile_item_idx` ON `playback_progress` (`profile_id`,`item_key`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `profile_id` integer REFERENCES household_profiles(id);--> statement-breakpoint
ALTER TABLE `app_devices` ADD `profile_id` integer REFERENCES household_profiles(id);--> statement-breakpoint
ALTER TABLE `playback_bookmarks` ADD `profile_id` integer REFERENCES household_profiles(id);--> statement-breakpoint
CREATE INDEX `playback_bookmarks_profile_item_idx` ON `playback_bookmarks` (`profile_id`,`item_key`);--> statement-breakpoint
ALTER TABLE `playback_plays` ADD `profile_id` integer REFERENCES household_profiles(id);--> statement-breakpoint
CREATE INDEX `playback_plays_profile_at_idx` ON `playback_plays` (`profile_id`,`at`);--> statement-breakpoint
ALTER TABLE `user_playlists` ADD `profile_id` integer REFERENCES household_profiles(id);--> statement-breakpoint
CREATE INDEX `user_playlists_profile_idx` ON `user_playlists` (`profile_id`);