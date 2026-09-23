ALTER TABLE `threat_models` ADD `archived_at` integer;--> statement-breakpoint
CREATE INDEX `idx_tm_archived_created_at` ON `threat_models` (`archived_at`, `created_at`);
