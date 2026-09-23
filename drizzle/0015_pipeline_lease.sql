ALTER TABLE "threat_models" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tm_lease" ON "threat_models" USING btree ("status","lease_expires_at");
