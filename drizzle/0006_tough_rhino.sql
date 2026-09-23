ALTER TABLE "threat_models" ADD COLUMN "system_description" text;--> statement-breakpoint
ALTER TABLE "threat_models" DROP COLUMN "executive_summary";--> statement-breakpoint
ALTER TABLE "threat_models" DROP COLUMN "csv_s3_url";--> statement-breakpoint
ALTER TABLE "threat_models" DROP COLUMN "markdown_s3_url";--> statement-breakpoint
ALTER TABLE "threat_models" DROP COLUMN "mermaid_s3_url";