CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`kind` text NOT NULL,
	`relative_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_event_type` ON `audit_logs` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_created_at` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `threat_models` (
	`id` text PRIMARY KEY NOT NULL,
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
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tm_status` ON `threat_models` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tm_version_hash` ON `threat_models` (`version_hash`);--> statement-breakpoint
CREATE INDEX `idx_tm_external_id` ON `threat_models` (`external_id`);--> statement-breakpoint
CREATE INDEX `idx_tm_created_at` ON `threat_models` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tm_cancel_requested` ON `threat_models` (`cancel_requested_at`);--> statement-breakpoint
CREATE INDEX `idx_tm_running_heartbeat` ON `threat_models` (`status`,`worker_heartbeat_at`);--> statement-breakpoint
CREATE TABLE `threats` (
	`id` text PRIMARY KEY NOT NULL,
	`threat_model_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`component` text,
	`stride_category` text,
	`pasta_phase` text,
	`methodology` text,
	`dread_damage` integer,
	`dread_reproducibility` integer,
	`dread_exploitability` integer,
	`dread_affected_users` integer,
	`dread_discoverability` integer,
	`severity` text,
	`impact` text,
	`mitigation` text,
	`control_reference` text,
	`attack_scenarios` text,
	`recommended_controls` text,
	`owasp_categories` text,
	`confidence_score` integer,
	`evidence_sources` text,
	`reasoning` text,
	`user_comments` text,
	`review_status` text,
	`review_reason` text,
	`review_notes` text,
	`reviewed_at` integer,
	`traceability` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`threat_model_id`) REFERENCES `threat_models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_threats_tm` ON `threats` (`threat_model_id`);--> statement-breakpoint
CREATE INDEX `idx_threats_severity` ON `threats` (`severity`);--> statement-breakpoint
CREATE INDEX `idx_threats_stride` ON `threats` (`stride_category`);--> statement-breakpoint
CREATE INDEX `idx_threats_review` ON `threats` (`review_status`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`original_name` text NOT NULL,
	`media_type` text NOT NULL,
	`content` text NOT NULL,
	`size` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_uploads_expires` ON `uploads` (`expires_at`);