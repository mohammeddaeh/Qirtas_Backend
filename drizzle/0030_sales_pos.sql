CREATE TYPE "public"."customer_ledger_reason" AS ENUM('sale_on_account', 'credit_spent', 'refund_to_credit', 'manual_adjustment');--> statement-breakpoint
CREATE TYPE "public"."sale_payment_method" AS ENUM('cash', 'card', 'customer_credit', 'on_account');--> statement-breakpoint
CREATE TYPE "public"."sale_status" AS ENUM('open', 'held', 'paid', 'void');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_credit_limits" (
	"customer_id" integer PRIMARY KEY NOT NULL,
	"limit_syp" numeric(14, 2) NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_ledger_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"amount_syp" numeric(14, 2) NOT NULL,
	"reason" "customer_ledger_reason" NOT NULL,
	"sale_id" integer,
	"note" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_role_discount_caps" (
	"role_id" integer PRIMARY KEY NOT NULL,
	"max_discount_percent" numeric(5, 2) NOT NULL,
	"can_approve" boolean DEFAULT false NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"sale_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"name_ar" text NOT NULL,
	"sku" varchar(40) NOT NULL,
	"unit_id" integer,
	"unit_name_ar" text,
	"unit_factor" numeric(14, 3) DEFAULT '1' NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"unit_price_syp" numeric(14, 2) NOT NULL,
	"promotion_discount_syp" numeric(14, 2) DEFAULT '0' NOT NULL,
	"promotion_names" text,
	"manual_discount_syp" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"tax_syp" numeric(14, 2) DEFAULT '0' NOT NULL,
	"line_total_syp" numeric(14, 2) DEFAULT '0' NOT NULL,
	"unit_cost_syp" numeric(14, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"sale_id" integer NOT NULL,
	"method" "sale_payment_method" NOT NULL,
	"amount_syp" numeric(14, 2) NOT NULL,
	"tendered_syp" numeric(14, 2),
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_sequences" (
	"branch_id" integer NOT NULL,
	"year" smallint NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sale_sequences_branch_id_year_pk" PRIMARY KEY("branch_id","year")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"status" "sale_status" DEFAULT 'open' NOT NULL,
	"number" varchar(40),
	"sequence" integer,
	"customer_id" integer,
	"customer_name" text,
	"cashier_user_id" integer NOT NULL,
	"discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"discount_reason" text,
	"discount_approved_by" integer,
	"subtotal_syp" numeric(14, 2) DEFAULT '0' NOT NULL,
	"discount_syp" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_syp" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_syp" numeric(14, 2) DEFAULT '0' NOT NULL,
	"usd_rate_syp" numeric(14, 2),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_credit_limits" ADD CONSTRAINT "customer_credit_limits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_credit_limits" ADD CONSTRAINT "customer_credit_limits_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_role_discount_caps" ADD CONSTRAINT "sale_role_discount_caps_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_role_discount_caps" ADD CONSTRAINT "sale_role_discount_caps_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_unit_id_catalog_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."catalog_units"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_sequences" ADD CONSTRAINT "sale_sequences_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales" ADD CONSTRAINT "sales_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales" ADD CONSTRAINT "sales_discount_approved_by_users_id_fk" FOREIGN KEY ("discount_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_ledger_customer_idx" ON "customer_ledger_entries" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_lines_sale_idx" ON "sale_lines" USING btree ("sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sale_lines_once" ON "sale_lines" USING btree ("sale_id","variant_id","unit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_payments_sale_idx" ON "sale_payments" USING btree ("sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_number_once" ON "sales" USING btree ("branch_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_branch_idx" ON "sales" USING btree ("branch_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_cashier_idx" ON "sales" USING btree ("cashier_user_id","status");