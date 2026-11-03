ALTER TABLE `household_profiles` ADD `failed_pin_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `household_profiles` ADD `pin_locked_until` integer;--> statement-breakpoint
ALTER TABLE `household_profiles` ADD `pin_lockouts` integer DEFAULT 0 NOT NULL;