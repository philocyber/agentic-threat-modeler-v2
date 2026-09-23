ALTER TYPE "analysis_status" ADD VALUE IF NOT EXISTS 'partial';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'reviewer_learning_applied';--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN IF NOT EXISTS "sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN IF NOT EXISTS "owner_principal_id" varchar(64);--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN IF NOT EXISTS "owner_principal_kind" varchar(20);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_uploads_owner" ON "uploads" USING btree ("owner_principal_kind", "owner_principal_id");--> statement-breakpoint
UPDATE "threat_models" SET "system_id" = NULL
WHERE "system_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "systems" WHERE "systems"."id" = "threat_models"."system_id");--> statement-breakpoint
ALTER TABLE "threat_models" DROP CONSTRAINT IF EXISTS "threat_models_system_id_systems_id_fk";--> statement-breakpoint
ALTER TABLE "threat_models" ADD CONSTRAINT "threat_models_system_id_systems_id_fk"
  FOREIGN KEY ("system_id") REFERENCES "public"."systems"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
