CREATE TYPE "public"."print_job_source" AS ENUM('app', 'counter', 'reprint');--> statement-breakpoint
ALTER TABLE "print_jobs" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "source" "print_job_source" DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "contact_name" varchar(120);--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "contact_phone" varchar(32);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_contact_idx" ON "print_jobs" USING btree ("contact_phone");