ALTER TABLE "customers" DROP CONSTRAINT "customers_wholesale_status_chk";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "wholesale_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "wholesale_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "wholesale_decided_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "wholesale_rejection_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customers" ADD CONSTRAINT "customers_wholesale_decided_by_user_id_users_id_fk" FOREIGN KEY ("wholesale_decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_wholesale_status_chk" CHECK (("customers"."wholesale_status" IS NULL AND "customers"."customer_type" = 'retail') OR ("customers"."wholesale_status" = 'approved' AND "customers"."customer_type" = 'wholesale') OR ("customers"."wholesale_status" IN ('pending', 'rejected') AND "customers"."customer_type" = 'retail'));