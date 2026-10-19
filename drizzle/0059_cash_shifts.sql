CREATE TYPE "public"."cash_movement_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."cash_shift_status" AS ENUM('open', 'closed');--> statement-breakpoint
ALTER TYPE "public"."finance_doc_type" ADD VALUE 'cash_shift';--> statement-breakpoint
ALTER TYPE "public"."finance_doc_type" ADD VALUE 'cash_movement';--> statement-breakpoint
ALTER TYPE "public"."finance_doc_type" ADD VALUE 'customer_ledger';--> statement-breakpoint
ALTER TYPE "public"."finance_entry_type" ADD VALUE 'cash_in';--> statement-breakpoint
ALTER TYPE "public"."finance_entry_type" ADD VALUE 'cash_out';--> statement-breakpoint
ALTER TYPE "public"."finance_entry_type" ADD VALUE 'cash_over';--> statement-breakpoint
ALTER TYPE "public"."finance_entry_type" ADD VALUE 'cash_short';--> statement-breakpoint
ALTER TYPE "public"."finance_entry_type" ADD VALUE 'debt_payment';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cash_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"shift_id" integer NOT NULL,
	"direction" "cash_movement_direction" NOT NULL,
	"amount_syp" numeric(14, 2) NOT NULL,
	"reason_code" varchar(30) NOT NULL,
	"note" text,
	"user_id" integer,
	"station_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cash_shifts" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"cashier_user_id" integer NOT NULL,
	"number" varchar(40) NOT NULL,
	"sequence" integer NOT NULL,
	"status" "cash_shift_status" DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_station_id" integer,
	"opening_suggested_syp" numeric(14, 2),
	"opening_counted_syp" numeric(14, 2) NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" integer,
	"closed_station_id" integer,
	"closed_on_behalf" boolean DEFAULT false NOT NULL,
	"counted_syp" numeric(14, 2),
	"left_in_drawer_syp" numeric(14, 2),
	"expected_syp" numeric(14, 2),
	"difference_syp" numeric(14, 2),
	"reason_required" boolean DEFAULT false NOT NULL,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "finance_entries" ADD COLUMN "shift_id" integer;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "shift_mode" varchar(10) DEFAULT 'required' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "shift_reason_above_syp" numeric(14, 2) DEFAULT '10000';--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "shift_alert_hours" integer DEFAULT 16 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shift_id_cash_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cash_shifts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_movements_shift_idx" ON "cash_movements" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_shifts_branch_opened_idx" ON "cash_shifts" USING btree ("branch_id","opened_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_shifts_cashier_idx" ON "cash_shifts" USING btree ("cashier_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cash_shifts_one_open_uq" ON "cash_shifts" USING btree ("branch_id","cashier_user_id") WHERE "cash_shifts"."status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_entries_shift_idx" ON "finance_entries" USING btree ("shift_id");