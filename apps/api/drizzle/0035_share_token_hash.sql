ALTER TABLE `wrapped_shares` ADD `token_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `wrapped_shares_token_hash_idx` ON `wrapped_shares` (`token_hash`);