CREATE TABLE `tag_rule_applications` (
	`rule_id` integer NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`applied_at` text NOT NULL,
	PRIMARY KEY(`rule_id`, `entity_type`, `entity_id`, `tag_id`),
	FOREIGN KEY (`rule_id`) REFERENCES `tag_rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tag_rule_applications_entity_idx` ON `tag_rule_applications` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `tag_rule_applications_tag_idx` ON `tag_rule_applications` (`tag_id`);--> statement-breakpoint
CREATE TABLE `tag_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`applies_to` text NOT NULL,
	`match` text DEFAULT 'all' NOT NULL,
	`conditions` text NOT NULL,
	`add_tags` text NOT NULL,
	`remove_tag_ids` text NOT NULL,
	`remove_when_unmatched` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`starter_key` text,
	`last_run` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tag_rules_sort_idx` ON `tag_rules` (`sort_order`);