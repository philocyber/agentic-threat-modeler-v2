UPDATE "threat_models"
SET
  "created_by_actor_type" = 'system',
  "created_by_actor_id" = 'legacy'
WHERE "created_by_actor_type" IS NULL
   OR "created_by_actor_id" IS NULL;--> statement-breakpoint
UPDATE "uploads"
SET
  "created_by_actor_type" = 'system',
  "created_by_actor_id" = 'legacy'
WHERE "created_by_actor_type" IS NULL
   OR "created_by_actor_id" IS NULL;
