CREATE TYPE "public"."promotion_channel" AS ENUM('online', 'pos', 'both');--> statement-breakpoint
CREATE TYPE "public"."promotion_kind" AS ENUM('percent', 'amount', 'buy_x_get_y', 'qty_tiers');--> statement-breakpoint
CREATE TYPE "public"."promotion_scope" AS ENUM('all_branches', 'branches');--> statement-breakpoint
CREATE TYPE "public"."promotion_segment" AS ENUM('retail', 'wholesale', 'all');--> statement-breakpoint
CREATE TYPE "public"."promotion_target" AS ENUM('variant', 'product', 'category', 'brand');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promotion_branch_caps" (
	"branch_id" integer PRIMARY KEY NOT NULL,
	"max_discount_percent" numeric(5, 2) NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promotion_branches" (
	"id" serial PRIMARY KEY NOT NULL,
	"promotion_id" integer NOT NULL,
	"branch_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promotion_tiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"promotion_id" integer NOT NULL,
	"min_qty" integer NOT NULL,
	"percent_value" numeric(5, 2),
	"amount_syp" numeric(14, 2)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promotions" (
	"id" serial PRIMARY KEY NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text,
	"scope" "promotion_scope" DEFAULT 'all_branches' NOT NULL,
	"target_kind" "promotion_target" NOT NULL,
	"variant_id" integer,
	"product_id" integer,
	"category_id" integer,
	"brand_id" integer,
	"kind" "promotion_kind" NOT NULL,
	"percent_value" numeric(5, 2),
	"amount_syp" numeric(14, 2),
	"buy_qty" integer,
	"get_qty" integer,
	"get_percent" numeric(5, 2),
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"channel" "promotion_channel" DEFAULT 'both' NOT NULL,
	"segment" "promotion_segment" DEFAULT 'all' NOT NULL,
	"is_stackable" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_one_target" CHECK ((CASE WHEN "promotions"."variant_id" IS NULL THEN 0 ELSE 1 END
         + CASE WHEN "promotions"."product_id" IS NULL THEN 0 ELSE 1 END
         + CASE WHEN "promotions"."category_id" IS NULL THEN 0 ELSE 1 END
         + CASE WHEN "promotions"."brand_id" IS NULL THEN 0 ELSE 1 END) = 1),
	CONSTRAINT "promotion_window_ordered" CHECK ("promotions"."starts_at" IS NULL OR "promotions"."ends_at" IS NULL OR "promotions"."ends_at" > "promotions"."starts_at")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promotion_branch_caps" ADD CONSTRAINT "promotion_branch_caps_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promotion_branch_caps" ADD CONSTRAINT "promotion_branch_caps_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promotion_branches" ADD CONSTRAINT "promotion_branches_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promotion_branches" ADD CONSTRAINT "promotion_branches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promotion_tiers" ADD CONSTRAINT "promotion_tiers_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promotions" ADD CONSTRAINT "promotions_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promotions" ADD CONSTRAINT "promotions_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promotions" ADD CONSTRAINT "promotions_category_id_catalog_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."catalog_categories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promotions" ADD CONSTRAINT "promotions_brand_id_catalog_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."catalog_brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promotions" ADD CONSTRAINT "promotions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promotion_branches_once" ON "promotion_branches" USING btree ("promotion_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promotion_tiers_once" ON "promotion_tiers" USING btree ("promotion_id","min_qty");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotions_live_idx" ON "promotions" USING btree ("is_active","archived_at","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotions_target_idx" ON "promotions" USING btree ("variant_id","product_id","category_id","brand_id");