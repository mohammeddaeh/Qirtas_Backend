ALTER TYPE "public"."inventory_doc_type" ADD VALUE 'return';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_return_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"return_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"qty_base" numeric(14, 3) NOT NULL,
	"unit_cost_syp" numeric(14, 2) NOT NULL,
	"unit_cost_usd" numeric(14, 4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_returns" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" varchar(40) NOT NULL,
	"branch_id" integer NOT NULL,
	"supplier_id" integer NOT NULL,
	"receipt_id" integer NOT NULL,
	"note" text NOT NULL,
	"total_syp" numeric(14, 2) NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "is_branch_draft" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "draft_branch_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_return_id_purchase_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."purchase_returns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_receipt_id_purchase_invoices_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_return_lines_return_idx" ON "purchase_return_lines" USING btree ("return_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_returns_number_unique" ON "purchase_returns" USING btree ("number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_returns_branch_idx" ON "purchase_returns" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_returns_receipt_idx" ON "purchase_returns" USING btree ("receipt_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_draft_branch_id_branches_id_fk" FOREIGN KEY ("draft_branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
