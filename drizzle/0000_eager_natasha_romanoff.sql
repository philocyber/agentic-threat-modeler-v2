CREATE TYPE "public"."analysis_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invalid_reason" AS ENUM('hallucination', 'out_of_scope', 'low_priority', 'duplicate', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."threat_priority" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system_name" varchar(255) NOT NULL,
	"status" "analysis_status" DEFAULT 'pending' NOT NULL,
	"input" text NOT NULL,
	"input_type" varchar(50) DEFAULT 'text',
	"config" jsonb,
	"architecture_json" jsonb,
	"threats_json" jsonb,
	"csv_output" text,
	"markdown_report" text,
	"mermaid_dfd" text,
	"total_threats" integer,
	"filtered_threats" integer,
	"high_confidence_threats" integer,
	"duration_ms" integer,
	"model_used" varchar(100),
	"error_message" text,
	"external_id" varchar(255),
	"webhook_url" text,
	"webhook_delivered" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "threat_validations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"threat_id" varchar(50) NOT NULL,
	"is_valid" boolean,
	"invalid_reason" "invalid_reason",
	"notes" text,
	"validated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "threat_validations" ADD CONSTRAINT "threat_validations_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analyses_status_idx" ON "analyses" USING btree ("status");--> statement-breakpoint
CREATE INDEX "analyses_external_id_idx" ON "analyses" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "analyses_created_at_idx" ON "analyses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "threat_validations_analysis_idx" ON "threat_validations" USING btree ("analysis_id");