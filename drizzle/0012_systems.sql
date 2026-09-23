CREATE TABLE IF NOT EXISTS "systems" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(500) NOT NULL,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_systems_name" ON "systems" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_systems_created_at" ON "systems" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "threat_models" ADD COLUMN IF NOT EXISTS "system_id" varchar(255);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tm_system_id" ON "threat_models" USING btree ("system_id");--> statement-breakpoint
ALTER TABLE "threats" ADD COLUMN IF NOT EXISTS "methodology_data" jsonb;