CREATE TYPE "public"."catalog_barcode_source" AS ENUM('manufacturer', 'internal');--> statement-breakpoint
CREATE TYPE "public"."catalog_product_status" AS ENUM('draft', 'active', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."catalog_variant_status" AS ENUM('active', 'discontinued');--> statement-breakpoint
CREATE SEQUENCE "public"."catalog_internal_barcode_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_barcodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"variant_unit_id" integer NOT NULL,
	"source" "catalog_barcode_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_product_media" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"variant_id" integer,
	"media_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"category_id" integer NOT NULL,
	"brand_id" integer,
	"kind" "catalog_product_kind" NOT NULL,
	"is_sellable" boolean DEFAULT true NOT NULL,
	"name_ar" varchar(200) NOT NULL,
	"name_en" varchar(200),
	"description_ar" text,
	"description_en" text,
	"search_keywords" text[] DEFAULT '{}' NOT NULL,
	"search_text" text NOT NULL,
	"price_policy" "catalog_price_policy",
	"pricing_currency" "catalog_pricing_currency",
	"status" "catalog_product_status" DEFAULT 'draft' NOT NULL,
	"created_by_user_id" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_variant_attribute_values" (
	"variant_id" integer NOT NULL,
	"attribute_type_id" integer NOT NULL,
	"attribute_value_id" integer NOT NULL,
	CONSTRAINT "catalog_variant_attribute_values_variant_id_attribute_type_id_pk" PRIMARY KEY("variant_id","attribute_type_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_variant_units" (
	"id" serial PRIMARY KEY NOT NULL,
	"variant_id" integer NOT NULL,
	"unit_id" integer NOT NULL,
	"factor" numeric(14, 3) NOT NULL,
	"is_base" boolean DEFAULT false NOT NULL,
	"sellable_online" boolean DEFAULT true NOT NULL,
	"sellable_at_pos" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_variants" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"sku" varchar(40) NOT NULL,
	"combination_key" varchar(60) NOT NULL,
	"base_unit_id" integer NOT NULL,
	"status" "catalog_variant_status" DEFAULT 'active' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_variants_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_collection_products" (
	"collection_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "catalog_collection_products_collection_id_product_id_pk" PRIMARY KEY("collection_id","product_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_collections" (
	"id" serial PRIMARY KEY NOT NULL,
	"name_ar" varchar(120) NOT NULL,
	"name_en" varchar(120),
	"image_id" integer,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_barcodes" ADD CONSTRAINT "catalog_barcodes_variant_unit_id_catalog_variant_units_id_fk" FOREIGN KEY ("variant_unit_id") REFERENCES "public"."catalog_variant_units"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_product_media" ADD CONSTRAINT "catalog_product_media_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_product_media" ADD CONSTRAINT "catalog_product_media_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_product_media" ADD CONSTRAINT "catalog_product_media_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_category_id_catalog_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."catalog_categories"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_brand_id_catalog_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."catalog_brands"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_variant_attribute_values" ADD CONSTRAINT "catalog_variant_attribute_values_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_variant_attribute_values" ADD CONSTRAINT "catalog_variant_attribute_values_attribute_type_id_catalog_attribute_types_id_fk" FOREIGN KEY ("attribute_type_id") REFERENCES "public"."catalog_attribute_types"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_variant_attribute_values" ADD CONSTRAINT "catalog_variant_attribute_values_attribute_value_id_catalog_attribute_values_id_fk" FOREIGN KEY ("attribute_value_id") REFERENCES "public"."catalog_attribute_values"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_variant_units" ADD CONSTRAINT "catalog_variant_units_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_variant_units" ADD CONSTRAINT "catalog_variant_units_unit_id_catalog_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."catalog_units"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_variants" ADD CONSTRAINT "catalog_variants_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_variants" ADD CONSTRAINT "catalog_variants_base_unit_id_catalog_units_id_fk" FOREIGN KEY ("base_unit_id") REFERENCES "public"."catalog_units"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_collection_products" ADD CONSTRAINT "catalog_collection_products_collection_id_catalog_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."catalog_collections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_collection_products" ADD CONSTRAINT "catalog_collection_products_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_collections" ADD CONSTRAINT "catalog_collections_image_id_media_assets_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_barcodes_code_unit_unique" ON "catalog_barcodes" USING btree ("code","variant_unit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_barcodes_code_idx" ON "catalog_barcodes" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_product_media_product_idx" ON "catalog_product_media" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_products_category_idx" ON "catalog_products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_products_brand_idx" ON "catalog_products" USING btree ("brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_variant_units_variant_unit_unique" ON "catalog_variant_units" USING btree ("variant_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_variants_product_combination_unique" ON "catalog_variants" USING btree ("product_id","combination_key");