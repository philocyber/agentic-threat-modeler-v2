ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'analysis_archived';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'analysis_restored';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'analysis_deleted';--> statement-breakpoint
ALTER TABLE "threat_models" ADD COLUMN IF NOT EXISTS "archived_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tm_archived_created_at" ON "threat_models" USING btree ("archived_at", "created_at");
