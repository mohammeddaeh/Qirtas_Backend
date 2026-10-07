-- «Print it again» is gone (2026-10-06): its open orders are cancelled, and every repeat is read as a counter order.
UPDATE "print_jobs" SET "status" = 'cancelled', "cancel_reason" = 'Print-it-again removed', "closed_at" = now(), "updated_at" = now() WHERE "source" = 'reprint' AND "closed_at" IS NULL;--> statement-breakpoint
UPDATE "print_jobs" SET "source" = 'counter' WHERE "source" = 'reprint';--> statement-breakpoint
ALTER TABLE "print_jobs" DROP COLUMN IF EXISTS "reprint_of";--> statement-breakpoint
ALTER TABLE "public"."print_jobs" ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."print_jobs" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."print_job_source";--> statement-breakpoint
CREATE TYPE "public"."print_job_source" AS ENUM('app', 'counter');--> statement-breakpoint
ALTER TABLE "public"."print_jobs" ALTER COLUMN "source" SET DATA TYPE "public"."print_job_source" USING "source"::"public"."print_job_source";--> statement-breakpoint
ALTER TABLE "public"."print_jobs" ALTER COLUMN "source" SET DEFAULT 'app';
