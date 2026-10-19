DROP INDEX IF EXISTS "cash_shifts_one_open_uq";--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "shift_stale_action" varchar(5) DEFAULT 'warn' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "shift_cash_out_approval_syp" numeric(14, 2) DEFAULT '50000';--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "shift_review_above_syp" numeric(14, 2) DEFAULT '50000';--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "shift_denominations" jsonb DEFAULT '[500,1000,2000,5000]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "reverses_movement_id" integer;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "approved_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD COLUMN "reason_code" varchar(30);--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD COLUMN "reviewed_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cash_shifts_branch_one_open_uq" ON "cash_shifts" USING btree ("branch_id") WHERE "cash_shifts"."status" = 'open';