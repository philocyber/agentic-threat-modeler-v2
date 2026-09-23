ALTER TABLE "threats" DROP CONSTRAINT IF EXISTS "threats_reviewed_by_users_id_fk";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_tm_created_by";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_audit_logs_actor_id";--> statement-breakpoint
ALTER TABLE "threat_models" DROP COLUMN IF EXISTS "created_by_actor_type";--> statement-breakpoint
ALTER TABLE "threat_models" DROP COLUMN IF EXISTS "created_by_actor_id";--> statement-breakpoint
ALTER TABLE "threat_models" DROP COLUMN IF EXISTS "cancel_requested_by_type";--> statement-breakpoint
ALTER TABLE "threat_models" DROP COLUMN IF EXISTS "cancel_requested_by_id";--> statement-breakpoint
ALTER TABLE "uploads" DROP COLUMN IF EXISTS "created_by_actor_type";--> statement-breakpoint
ALTER TABLE "uploads" DROP COLUMN IF EXISTS "created_by_actor_id";--> statement-breakpoint
ALTER TABLE "threats" DROP COLUMN IF EXISTS "reviewed_by";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "actor_type";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "actor_id";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "actor_email";--> statement-breakpoint
DROP TABLE IF EXISTS "refresh_tokens";--> statement-breakpoint
DROP TABLE IF EXISTS "service_accounts";--> statement-breakpoint
DROP TABLE IF EXISTS "users";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."actor_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."user_role";
