ALTER TYPE "public"."finance_doc_type" ADD VALUE 'supplier_payment';--> statement-breakpoint
ALTER TYPE "public"."finance_doc_type" ADD VALUE 'supplier_conversion';--> statement-breakpoint
ALTER TYPE "public"."finance_entry_type" ADD VALUE 'supplier_payment';--> statement-breakpoint
ALTER TYPE "public"."finance_entry_type" ADD VALUE 'fx_gain';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"payment_id" integer NOT NULL,
	"invoice_id" integer,
	"bucket" varchar(3) NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"fx_gain_syp" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_conversions" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"amount_usd" numeric(14, 4) NOT NULL,
	"rate" numeric(14, 4) NOT NULL,
	"amount_syp" numeric(14, 2) NOT NULL,
	"fx_gain_syp" numeric(14, 2) NOT NULL,
	"note" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"supplier_id" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"fx_rate" numeric(14, 4) NOT NULL,
	"source" varchar(10) NOT NULL,
	"shift_id" integer,
	"movement_id" integer,
	"note" text,
	"reverses_payment_id" integer,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_allocations" ADD CONSTRAINT "supplier_allocations_payment_id_supplier_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_allocations" ADD CONSTRAINT "supplier_allocations_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_conversions" ADD CONSTRAINT "supplier_conversions_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_conversions" ADD CONSTRAINT "supplier_conversions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_allocations_payment_idx" ON "supplier_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_allocations_invoice_idx" ON "supplier_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_conversions_invoice_idx" ON "supplier_conversions" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_payments_supplier_idx" ON "supplier_payments" USING btree ("supplier_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_payments_branch_idx" ON "supplier_payments" USING btree ("branch_id","created_at");