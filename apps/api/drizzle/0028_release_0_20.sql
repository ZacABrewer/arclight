CREATE TABLE `soulseek_downloads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`album_id` integer NOT NULL,
	`artist_id` integer NOT NULL,
	`username` text NOT NULL,
	`directory` text NOT NULL,
	`files` text NOT NULL,
	`quality_name` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `soulseek_downloads_status_idx` ON `soulseek_downloads` (`status`);--> statement-breakpoint
CREATE INDEX `soulseek_downloads_album_idx` ON `soulseek_downloads` (`album_id`);--> statement-breakpoint
CREATE TABLE `music_playlist_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`artist` text NOT NULL,
	`album` text,
	`duration_ms` integer,
	`isrc` text,
	`status` text NOT NULL,
	`match_method` text,
	`recording_mbid` text,
	`release_group_mbid` text,
	`artist_mbid` text,
	`artist_id` integer,
	`album_id` integer,
	`track_id` integer,
	FOREIGN KEY (`playlist_id`) REFERENCES `music_playlists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `music_playlist_entries_playlist_idx` ON `music_playlist_entries` (`playlist_id`,`position`);--> statement-breakpoint
CREATE TABLE `music_playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`want` text DEFAULT 'none' NOT NULL,
	`add_artists` integer DEFAULT false NOT NULL,
	`root_folder_path` text,
	`quality_profile_id` integer,
	`search_on_want` integer DEFAULT false NOT NULL,
	`write_m3u` integer DEFAULT true NOT NULL,
	`targets` text NOT NULL,
	`target_state` text NOT NULL,
	`owned_album_ids` text NOT NULL,
	`sync_interval_hours` integer DEFAULT 24 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source_title` text,
	`last_sync_at` text,
	`last_sync_status` text DEFAULT 'never' NOT NULL,
	`last_sync_message` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `podcast_episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`podcast_id` integer NOT NULL,
	`guid` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`published_at` text,
	`duration_seconds` integer,
	`season` integer,
	`episode_number` integer,
	`episode_type` text DEFAULT 'full' NOT NULL,
	`explicit` integer DEFAULT false NOT NULL,
	`image_url` text,
	`link` text,
	`enclosure` text,
	`alternate_enclosures` text NOT NULL,
	`chapters_url` text,
	`transcripts` text NOT NULL,
	`persons` text NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`path` text,
	`size_bytes` integer,
	`downloaded_at` text,
	`has_chapters` integer DEFAULT false NOT NULL,
	`transcript_files` text NOT NULL,
	`played` integer DEFAULT false NOT NULL,
	`played_at` text,
	`played_source` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`added` text NOT NULL,
	FOREIGN KEY (`podcast_id`) REFERENCES `podcasts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `podcast_episodes_guid_idx` ON `podcast_episodes` (`podcast_id`,`guid`);--> statement-breakpoint
CREATE INDEX `podcast_episodes_status_idx` ON `podcast_episodes` (`status`);--> statement-breakpoint
CREATE INDEX `podcast_episodes_published_idx` ON `podcast_episodes` (`published_at`);--> statement-breakpoint
CREATE TABLE `podcast_suggestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`feed_url` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`image_url` text,
	`itunes_id` integer,
	`podcast_index_id` integer,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`podcast_id` integer,
	`decline_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`podcast_id`) REFERENCES `podcasts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `podcast_suggestions_user_idx` ON `podcast_suggestions` (`user_id`);--> statement-breakpoint
CREATE INDEX `podcast_suggestions_status_idx` ON `podcast_suggestions` (`status`);--> statement-breakpoint
CREATE TABLE `podcasts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`sort_title` text NOT NULL,
	`author` text,
	`description` text DEFAULT '' NOT NULL,
	`feed_url` text NOT NULL,
	`link` text,
	`image_url` text,
	`language` text,
	`categories` text NOT NULL,
	`explicit` integer DEFAULT false NOT NULL,
	`feed_type` text DEFAULT 'episodic' NOT NULL,
	`podcast_guid` text,
	`itunes_id` integer,
	`podcast_index_id` integer,
	`funding` text NOT NULL,
	`path` text NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`settings` text NOT NULL,
	`tags` text NOT NULL,
	`etag` text,
	`last_modified` text,
	`ttl_minutes` integer,
	`added` text NOT NULL,
	`last_refreshed` text,
	`next_refresh_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `podcasts_feed_url_idx` ON `podcasts` (`feed_url`);--> statement-breakpoint
CREATE INDEX `podcasts_next_refresh_idx` ON `podcasts` (`next_refresh_at`);--> statement-breakpoint
CREATE INDEX `podcasts_guid_idx` ON `podcasts` (`podcast_guid`);--> statement-breakpoint
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
CREATE INDEX `ebooks_release_date_idx` ON `ebooks` (`release_date`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notification_id` integer,
	`destination_id` integer,
	`event_type` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`error` text,
	`code` text,
	`test` integer DEFAULT false NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `user_notification_destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_deliveries_notification_idx` ON `notification_deliveries` (`notification_id`,`id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_destination_idx` ON `notification_deliveries` (`destination_id`,`id`);--> statement-breakpoint
CREATE TABLE `user_notification_destinations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`implementation` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`events` text NOT NULL,
	`settings` text NOT NULL,
	`templates` text DEFAULT '{}' NOT NULL,
	`quiet_hours` text,
	`added_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_notification_destinations_user_idx` ON `user_notification_destinations` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_notification_held` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`destination_id` integer NOT NULL,
	`event` text NOT NULL,
	`held_at` text NOT NULL,
	`reason` text DEFAULT 'quiet' NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `user_notification_destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_notification_held_destination_idx` ON `user_notification_held` (`destination_id`);--> statement-breakpoint
CREATE TABLE `user_api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`expires_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_api_keys_hash_idx` ON `user_api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `user_api_keys_user_idx` ON `user_api_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`provider_id` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`linked_at` text NOT NULL,
	`last_login_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_subject_idx` ON `user_identities` (`provider_id`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_user_idx` ON `user_identities` (`user_id`,`provider_id`);--> statement-breakpoint
CREATE TABLE `user_two_factor` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`totp_secret` text NOT NULL,
	`enabled_at` text,
	`last_step` integer DEFAULT 0 NOT NULL,
	`recovery_codes` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `webauthn_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text DEFAULT '[]' NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_credentials_cred_idx` ON `webauthn_credentials` (`credential_id`);--> statement-breakpoint
CREATE INDEX `webauthn_credentials_user_idx` ON `webauthn_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `import_list_additions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_list_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`added_at` text NOT NULL,
	FOREIGN KEY (`import_list_id`) REFERENCES `import_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_list_additions_list_media_tmdb_idx` ON `import_list_additions` (`import_list_id`,`media_type`,`tmdb_id`);--> statement-breakpoint
CREATE TABLE `import_list_id_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`media_type` text,
	`tmdb_id` integer,
	`imdb_id` text,
	`title` text,
	`year` integer,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_list_id_cache_ns_key_idx` ON `import_list_id_cache` (`namespace`,`key`);--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE `album_type_profiles` ADD `edition_preference` text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE `album_type_profiles` ADD `preferred_countries` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `album_type_profiles` ADD `preferred_formats` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `monitored` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `tracked_downloads` ADD `safety_checked_at` text;--> statement-breakpoint
ALTER TABLE `notification_held` ADD `reason` text DEFAULT 'quiet' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_download_rejected` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_podcast_episodes` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `on_podcast_download` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `filters` text DEFAULT '{"mediaTypes":[],"qualities":[],"users":[]}' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `templates` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `quiet_hours` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `rate_limit_per_minute` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `max_attempts` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `method` text;--> statement-breakpoint
ALTER TABLE `import_lists` ADD `sync_interval_hours` integer;--> statement-breakpoint
ALTER TABLE `import_lists` ADD `filters` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `import_lists` ADD `streaming` text DEFAULT '{"enabled":false,"providerIds":[]}' NOT NULL;--> statement-breakpoint
ALTER TABLE `import_lists` ADD `cleanup_action` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_server_users` ADD `local_id` text;