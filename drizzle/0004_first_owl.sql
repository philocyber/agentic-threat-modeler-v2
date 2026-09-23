ALTER TABLE "analyses" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "version_hash" varchar(64);