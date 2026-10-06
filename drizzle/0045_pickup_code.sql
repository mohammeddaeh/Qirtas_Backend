ALTER TABLE "print_jobs" ADD COLUMN "pickup_code" varchar(24);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_pickup_idx" ON "print_jobs" USING btree ("branch_id","pickup_code");