ALTER TABLE "threat_models" ADD COLUMN IF NOT EXISTS "created_by_actor_type" varchar(20);--> statement-breakpoint
ALTER TABLE "threat_models" ADD COLUMN IF NOT EXISTS "created_by_actor_id" varchar(255);--> statement-breakpoint
ALTER TABLE "threat_models" ADD COLUMN IF NOT EXISTS "pipeline_errors" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tm_created_by" ON "threat_models" USING btree ("created_by_actor_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_name" varchar(500) NOT NULL,
	"media_type" varchar(100) NOT NULL,
	"content" text NOT NULL,
	"size" integer NOT NULL,
	"created_by_actor_type" varchar(20),
	"created_by_actor_id" varchar(255),
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_uploads_expires" ON "uploads" USING btree ("expires_at");
