CREATE TABLE `media_server_tag_locks` (
	`server_id` text NOT NULL,
	`remote_item_id` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `remote_item_id`)
);
