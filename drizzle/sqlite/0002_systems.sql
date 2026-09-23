CREATE TABLE `systems` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_systems_name` ON `systems` (`name`);--> statement-breakpoint
CREATE INDEX `idx_systems_created_at` ON `systems` (`created_at`);--> statement-breakpoint
ALTER TABLE `threat_models` ADD `system_id` text REFERENCES `systems`(`id`);--> statement-breakpoint
CREATE INDEX `idx_tm_system_id` ON `threat_models` (`system_id`);--> statement-breakpoint
ALTER TABLE `threats` ADD `methodology_data` text;