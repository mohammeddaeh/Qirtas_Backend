ALTER TABLE "print_jobs" ADD COLUMN "from_ready_copies" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "ready_value_syp" numeric(14, 2);--> statement-breakpoint
UPDATE "print_jobs" SET "from_ready_copies" = "copies" WHERE "fulfilled_from_ready_id" IS NOT NULL;
