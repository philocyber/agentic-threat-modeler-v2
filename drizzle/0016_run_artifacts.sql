CREATE TABLE "run_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar(255) NOT NULL,
	"kind" varchar(200) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_workers" (
	"instance_id" varchar(128) PRIMARY KEY NOT NULL,
	"heartbeat_at" timestamp NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_run_id_threat_models_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."threat_models"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_run_artifacts_run_id" ON "run_artifacts" USING btree ("run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_run_artifacts_run_kind" ON "run_artifacts" USING btree ("run_id","kind");
