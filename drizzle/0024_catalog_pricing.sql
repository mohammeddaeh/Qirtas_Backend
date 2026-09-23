CREATE TABLE IF NOT EXISTS "catalog_branch_listings" (
	"branch_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"is_listed" boolean NOT NULL,
	"updated_by_user_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_branch_listings_branch_id_variant_id_pk" PRIMARY KEY("branch_id","variant_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_branch_prices" (
	"branch_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" "catalog_pricing_currency" NOT NULL,
	"updated_by_user_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_branch_prices_branch_id_variant_id_pk" PRIMARY KEY("branch_id","variant_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_exchange_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"usd_to_syp" numeric(14, 2) NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_price_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"variant_id" integer NOT NULL,
	"branch_id" integer,
	"field" varchar(24) NOT NULL,
	"old_amount" numeric(14, 3),
	"old_currency" "catalog_pricing_currency",
	"new_amount" numeric(14, 3),
	"new_currency" "catalog_pricing_currency",
	"source" varchar(12) NOT NULL,
	"changed_by_user_id" integer,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_pricing_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"rounding_bands" jsonb NOT NULL,
	"updated_by_user_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_variant_prices" (
	"variant_id" integer PRIMARY KEY NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" "catalog_pricing_currency" NOT NULL,
	"wholesale_amount" numeric(14, 2),
	"wholesale_min_qty" numeric(14, 3),
	"updated_by_user_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_categories" ADD COLUMN "price_band_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "catalog_categories" ADD COLUMN "wholesale_discount_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "catalog_categories" ADD COLUMN "wholesale_min_qty" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "catalog_categories" ADD COLUMN "tax_rate_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "price_band_percent" numeric(5, 2);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_branch_listings" ADD CONSTRAINT "catalog_branch_listings_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_branch_listings" ADD CONSTRAINT "catalog_branch_listings_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_branch_listings" ADD CONSTRAINT "catalog_branch_listings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_branch_prices" ADD CONSTRAINT "catalog_branch_prices_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_branch_prices" ADD CONSTRAINT "catalog_branch_prices_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_branch_prices" ADD CONSTRAINT "catalog_branch_prices_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_exchange_rates" ADD CONSTRAINT "catalog_exchange_rates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_price_history" ADD CONSTRAINT "catalog_price_history_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_price_history" ADD CONSTRAINT "catalog_price_history_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_price_history" ADD CONSTRAINT "catalog_price_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_pricing_settings" ADD CONSTRAINT "catalog_pricing_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_variant_prices" ADD CONSTRAINT "catalog_variant_prices_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_variant_prices" ADD CONSTRAINT "catalog_variant_prices_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_branch_prices_variant_idx" ON "catalog_branch_prices" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_price_history_variant_idx" ON "catalog_price_history" USING btree ("variant_id","changed_at");--> statement-breakpoint
INSERT INTO "catalog_pricing_settings" ("id", "rounding_bands") VALUES (1, '[{"below":1000,"step":50},{"below":10000,"step":100},{"below":null,"step":500}]'::jsonb) ON CONFLICT ("id") DO NOTHING;
