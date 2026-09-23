CREATE TYPE "public"."audit_event_type" AS ENUM('login_success', 'login_failed', 'logout', 'token_issued', 'token_refresh', 'token_revoked', 'service_account_auth', 'service_account_auth_failed', 'analysis_requested', 'analysis_completed', 'analysis_failed', 'threat_justified', 'threat_dismissed', 'threat_confirmed', 'threat_comment_added', 'threat_review_updated', 'user_created', 'user_deactivated', 'password_changed', 'service_account_created', 'service_account_rotated', 'rag_index_updated');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" "audit_event_type" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" varchar(255),
	"actor_email" varchar(255),
	"ip_address" "inet",
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "auth_logs" CASCADE;--> statement-breakpoint
CREATE INDEX "idx_audit_logs_event_type" ON "audit_logs" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_actor_id" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
DROP TYPE "public"."auth_event_type";