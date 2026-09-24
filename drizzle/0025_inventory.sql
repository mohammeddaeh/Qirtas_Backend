CREATE TYPE "public"."stock_adjustment_reason" AS ENUM('damage', 'loss', 'expiry', 'sample', 'internal_use', 'other');--> statement-breakpoint
CREATE TYPE "public"."stock_adjustment_status" AS ENUM('pending_approval', 'posted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."inventory_doc_type" AS ENUM('receipt', 'adjustment', 'transfer', 'count');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_type" AS ENUM('receipt', 'sale', 'return_in', 'return_to_supplier', 'transfer_out', 'transfer_in', 'count_adjustment', 'damage', 'production_consume');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(150) NOT NULL,
	"search_text" text NOT NULL,
	"phone" varchar(30),
	"email" varchar(150),
	"address" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_doc_sequences" (
	"branch_id" integer NOT NULL,
	"doc_type" "inventory_doc_type" NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "inventory_doc_sequences_branch_id_doc_type_pk" PRIMARY KEY("branch_id","doc_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"approval_threshold_syp" numeric(14, 2) NOT NULL,
	"expiry_alert_days" integer DEFAULT 30 NOT NULL,
	"updated_by_user_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_adjustment_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"adjustment_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"qty_base" numeric(14, 3) NOT NULL,
	"unit_cost_syp" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"number" varchar(40) NOT NULL,
	"reason" "stock_adjustment_reason" NOT NULL,
	"note" text NOT NULL,
	"status" "stock_adjustment_status" NOT NULL,
	"total_value_syp" numeric(14, 2) NOT NULL,
	"created_by_user_id" integer,
	"decided_by_user_id" integer,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_balances" (
	"branch_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"on_hand" numeric(14, 3) DEFAULT '0' NOT NULL,
	"reserved" numeric(14, 3) DEFAULT '0' NOT NULL,
	"avg_cost_syp" numeric(14, 2) DEFAULT '0' NOT NULL,
	"avg_cost_usd" numeric(14, 4) DEFAULT '0' NOT NULL,
	"reorder_threshold" numeric(14, 3),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_branch_id_variant_id_pk" PRIMARY KEY("branch_id","variant_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"type" "stock_movement_type" NOT NULL,
	"qty_base" numeric(14, 3) NOT NULL,
	"unit_cost_syp" numeric(14, 2),
	"unit_cost_usd" numeric(14, 4),
	"source_doc_type" "inventory_doc_type",
	"source_doc_id" integer,
	"note" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_receipt_layers" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"receipt_id" integer NOT NULL,
	"qty_base" numeric(14, 3) NOT NULL,
	"remaining_base" numeric(14, 3) NOT NULL,
	"unit_cost_syp" numeric(14, 2) NOT NULL,
	"unit_cost_usd" numeric(14, 4) NOT NULL,
	"expires_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_invoice_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"unit_id" integer NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"factor" numeric(14, 3) NOT NULL,
	"qty_base" numeric(14, 3) NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"unit_cost_base_syp" numeric(14, 2) NOT NULL,
	"unit_cost_base_usd" numeric(14, 4) NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"supplier_id" integer NOT NULL,
	"number" varchar(40) NOT NULL,
	"supplier_invoice_no" varchar(60),
	"invoice_date" timestamp with time zone NOT NULL,
	"currency" "catalog_pricing_currency" NOT NULL,
	"exchange_rate" numeric(14, 2),
	"total_syp" numeric(14, 2) NOT NULL,
	"total_usd" numeric(14, 4) NOT NULL,
	"note" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_doc_sequences" ADD CONSTRAINT "inventory_doc_sequences_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_adjustment_id_stock_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."stock_adjustments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt_layers" ADD CONSTRAINT "stock_receipt_layers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt_layers" ADD CONSTRAINT "stock_receipt_layers_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_unit_id_catalog_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."catalog_units"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_search_idx" ON "suppliers" USING btree ("search_text");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_adjustment_lines_adjustment_idx" ON "stock_adjustment_lines" USING btree ("adjustment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_adjustments_number_unique" ON "stock_adjustments" USING btree ("number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_adjustments_branch_idx" ON "stock_adjustments" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_balances_variant_idx" ON "stock_balances" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_movements_branch_variant_idx" ON "stock_movements" USING btree ("branch_id","variant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_movements_doc_idx" ON "stock_movements" USING btree ("source_doc_type","source_doc_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_layers_branch_variant_idx" ON "stock_receipt_layers" USING btree ("branch_id","variant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_layers_expiry_idx" ON "stock_receipt_layers" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_invoice_lines_invoice_idx" ON "purchase_invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_invoice_lines_variant_idx" ON "purchase_invoice_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_invoices_number_unique" ON "purchase_invoices" USING btree ("number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_invoices_branch_idx" ON "purchase_invoices" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_invoices_supplier_idx" ON "purchase_invoices" USING btree ("supplier_id");INSERT INTO "inventory_settings" ("id", "approval_threshold_syp", "expiry_alert_days") VALUES (1, 100000, 30) ON CONFLICT ("id") DO NOTHING;
