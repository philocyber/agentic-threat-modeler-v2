ALTER TABLE "threat_models" ADD COLUMN IF NOT EXISTS "cancel_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "threat_models" ADD COLUMN IF NOT EXISTS "cancel_requested_by_type" varchar(20);--> statement-breakpoint
ALTER TABLE "threat_models" ADD COLUMN IF NOT EXISTS "cancel_requested_by_id" varchar(255);--> statement-breakpoint
ALTER TABLE "threat_models" ADD COLUMN IF NOT EXISTS "cancel_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "threat_models" ADD COLUMN IF NOT EXISTS "worker_instance_id" varchar(128);--> statement-breakpoint
ALTER TABLE "threat_models" ADD COLUMN IF NOT EXISTS "worker_heartbeat_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tm_cancel_requested" ON "threat_models" USING btree ("cancel_requested_at") WHERE "cancel_requested_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tm_running_heartbeat" ON "threat_models" USING btree ("status", "worker_heartbeat_at") WHERE "status" = 'running';
