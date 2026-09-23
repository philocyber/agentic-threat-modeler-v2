CREATE TYPE "public"."threat_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TABLE "threat_models" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"title" varchar(500),
	"input" text NOT NULL,
	"supporting_documents" jsonb,
	"metadata" jsonb,
	"version_hash" varchar(64) NOT NULL,
	"status" "analysis_status" DEFAULT 'pending' NOT NULL,
	"current_phase" varchar(100),
	"error_message" text,
	"executive_summary" text,
	"debate_summary" text,
	"methodologies_used" jsonb,
	"architecture_json" jsonb,
	"llm_tokens_used" integer,
	"execution_time_seconds" integer,
	"total_threats" integer,
	"filtered_threats" integer,
	"csv_s3_url" text,
	"markdown_s3_url" text,
	"mermaid_s3_url" text,
	"external_id" varchar(255),
	"webhook_url" text,
	"webhook_delivered" boolean DEFAULT false,
	"queued_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threats" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"threat_model_id" varchar(255) NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text NOT NULL,
	"component" varchar(255),
	"stride_category" varchar(50),
	"pasta_phase" varchar(100),
	"methodology" varchar(50),
	"dread_damage" integer,
	"dread_reproducibility" integer,
	"dread_exploitability" integer,
	"dread_affected_users" integer,
	"dread_discoverability" integer,
	"severity" "threat_severity",
	"impact" text,
	"mitigation" text,
	"control_reference" varchar(255),
	"attack_scenarios" jsonb,
	"recommended_controls" jsonb,
	"owasp_categories" jsonb,
	"confidence_score" integer,
	"evidence_sources" jsonb,
	"reasoning" text,
	"user_comments" text,
	"review_status" varchar(20),
	"review_reason" varchar(100),
	"review_notes" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "analyses" CASCADE;--> statement-breakpoint
DROP TABLE "threat_validations" CASCADE;--> statement-breakpoint
ALTER TABLE "threats" ADD CONSTRAINT "threats_threat_model_id_threat_models_id_fk" FOREIGN KEY ("threat_model_id") REFERENCES "public"."threat_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threats" ADD CONSTRAINT "threats_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tm_status" ON "threat_models" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tm_version_hash" ON "threat_models" USING btree ("version_hash");--> statement-breakpoint
CREATE INDEX "idx_tm_external_id" ON "threat_models" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "idx_tm_created_at" ON "threat_models" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_threats_tm" ON "threats" USING btree ("threat_model_id");--> statement-breakpoint
CREATE INDEX "idx_threats_severity" ON "threats" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_threats_stride" ON "threats" USING btree ("stride_category");--> statement-breakpoint
CREATE INDEX "idx_threats_review" ON "threats" USING btree ("review_status");