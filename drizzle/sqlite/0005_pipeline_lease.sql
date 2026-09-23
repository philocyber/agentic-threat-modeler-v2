ALTER TABLE `threat_models` ADD `lease_expires_at` integer;--> statement-breakpoint
CREATE INDEX `idx_tm_lease` ON `threat_models` (`status`, `lease_expires_at`);
