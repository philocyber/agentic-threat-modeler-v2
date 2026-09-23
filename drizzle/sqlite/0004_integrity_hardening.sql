PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_threat_models` (
  `id` text PRIMARY KEY NOT NULL,
  `system_id` text REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE set null,
  `title` text,
  `input` text NOT NULL,
  `supporting_documents` text,
  `metadata` text,
  `version_hash` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `current_phase` text,
  `error_message` text,
  `cancel_requested_at` integer,
  `cancel_generation` integer DEFAULT 0 NOT NULL,
  `worker_instance_id` text,
  `worker_heartbeat_at` integer,
  `system_description` text,
  `debate_summary` text,
  `methodologies_used` text,
  `architecture_json` text,
  `llm_tokens_used` integer,
  `execution_time_seconds` integer,
  `total_threats` integer,
  `filtered_threats` integer,
  `external_id` text,
  `webhook_url` text,
  `webhook_delivered` integer DEFAULT false,
  `pipeline_errors` text,
  `queued_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `started_at` integer,
  `completed_at` integer,
  `archived_at` integer,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_threat_models` SELECT
  `id`, CASE WHEN EXISTS (SELECT 1 FROM `systems` WHERE `systems`.`id` = `threat_models`.`system_id`) THEN `system_id` ELSE NULL END,
  `title`, `input`, `supporting_documents`, `metadata`, `version_hash`, `status`, `current_phase`, `error_message`,
  `cancel_requested_at`, `cancel_generation`, `worker_instance_id`, `worker_heartbeat_at`, `system_description`, `debate_summary`,
  `methodologies_used`, `architecture_json`, `llm_tokens_used`, `execution_time_seconds`, `total_threats`, `filtered_threats`,
  `external_id`, `webhook_url`, `webhook_delivered`, `pipeline_errors`, `queued_at`, `started_at`, `completed_at`, `archived_at`,
  `created_at`, `updated_at` FROM `threat_models`;--> statement-breakpoint
DROP TABLE `threat_models`;--> statement-breakpoint
ALTER TABLE `__new_threat_models` RENAME TO `threat_models`;--> statement-breakpoint
CREATE INDEX `idx_tm_status` ON `threat_models` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tm_version_hash` ON `threat_models` (`version_hash`);--> statement-breakpoint
CREATE INDEX `idx_tm_system_id` ON `threat_models` (`system_id`);--> statement-breakpoint
CREATE INDEX `idx_tm_external_id` ON `threat_models` (`external_id`);--> statement-breakpoint
CREATE INDEX `idx_tm_created_at` ON `threat_models` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tm_archived_created_at` ON `threat_models` (`archived_at`, `created_at`);--> statement-breakpoint
CREATE INDEX `idx_tm_cancel_requested` ON `threat_models` (`cancel_requested_at`);--> statement-breakpoint
CREATE INDEX `idx_tm_running_heartbeat` ON `threat_models` (`status`, `worker_heartbeat_at`);--> statement-breakpoint
CREATE TABLE `__new_artifacts` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL REFERENCES `threat_models`(`id`) ON UPDATE no action ON DELETE cascade,
  `kind` text NOT NULL,
  `relative_path` text NOT NULL,
  `mime_type` text NOT NULL,
  `sha256` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_artifacts`
SELECT `id`, `run_id`, `kind`, `relative_path`, `mime_type`, `sha256`, `size_bytes`, `created_at`
FROM `artifacts` WHERE `run_id` IS NOT NULL AND EXISTS (
  SELECT 1 FROM `threat_models` WHERE `threat_models`.`id` = `artifacts`.`run_id`
);--> statement-breakpoint
DROP TABLE `artifacts`;--> statement-breakpoint
ALTER TABLE `__new_artifacts` RENAME TO `artifacts`;--> statement-breakpoint
CREATE INDEX `idx_artifacts_run_id` ON `artifacts` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_artifacts_run_kind` ON `artifacts` (`run_id`, `kind`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
