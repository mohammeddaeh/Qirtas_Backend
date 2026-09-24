CREATE TYPE "public"."stock_count_scope" AS ENUM('full', 'category', 'list');--> statement-breakpoint
CREATE TYPE "public"."stock_count_status" AS ENUM('open', 'pending_approval', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."stock_discrepancy_resolution" AS ENUM('loss', 'returned');--> statement-breakpoint
CREATE TYPE "public"."stock_transfer_status" AS ENUM('requested', 'approved', 'rejected', 'in_transit', 'received', 'received_with_discrepancy', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_count_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"count_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"counted_qty" numeric(14, 3) NOT NULL,
	"system_qty" numeric(14, 3) NOT NULL,
	"unit_cost_syp" numeric(14, 2) NOT NULL,
	"counted_by_user_id" integer,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_counts" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" varchar(40) NOT NULL,
	"branch_id" integer NOT NULL,
	"scope" "stock_count_scope" NOT NULL,
	"category_id" integer,
	"status" "stock_count_status" NOT NULL,
	"note" text,
	"diff_value_syp" numeric(14, 2),
	"started_by_user_id" integer,
	"decided_by_user_id" integer,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_transfer_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"transfer_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"qty_requested" numeric(14, 3) NOT NULL,
	"qty_shipped" numeric(14, 3),
	"qty_received" numeric(14, 3),
	"unit_cost_syp" numeric(14, 2),
	"unit_cost_usd" numeric(14, 4)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" varchar(40) NOT NULL,
	"from_branch_id" integer NOT NULL,
	"to_branch_id" integer NOT NULL,
	"status" "stock_transfer_status" NOT NULL,
	"note" text,
	"resolution" "stock_discrepancy_resolution",
	"resolution_note" text,
	"requested_by_user_id" integer,
	"approved_by_user_id" integer,
	"shipped_by_user_id" integer,
	"received_by_user_id" integer,
	"shipped_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_id_stock_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."stock_counts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_counted_by_user_id_users_id_fk" FOREIGN KEY ("counted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_branch_id_branches_id_fk" FOREIGN KEY ("from_branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_branch_id_branches_id_fk" FOREIGN KEY ("to_branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_shipped_by_user_id_users_id_fk" FOREIGN KEY ("shipped_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_count_lines_count_idx" ON "stock_count_lines" USING btree ("count_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_count_lines_variant_unique" ON "stock_count_lines" USING btree ("count_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_counts_number_unique" ON "stock_counts" USING btree ("number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_counts_branch_idx" ON "stock_counts" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfer_lines_transfer_idx" ON "stock_transfer_lines" USING btree ("transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_transfers_number_unique" ON "stock_transfers" USING btree ("number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_from_idx" ON "stock_transfers" USING btree ("from_branch_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_to_idx" ON "stock_transfers" USING btree ("to_branch_id","status");