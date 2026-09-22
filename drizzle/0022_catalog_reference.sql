CREATE TYPE "public"."catalog_attribute_display" AS ENUM('swatch', 'text');--> statement-breakpoint
CREATE TYPE "public"."catalog_price_policy" AS ENUM('central_locked', 'branch_free', 'branch_banded');--> statement-breakpoint
CREATE TYPE "public"."catalog_pricing_currency" AS ENUM('SYP', 'USD');--> statement-breakpoint
CREATE TYPE "public"."catalog_product_kind" AS ENUM('retail', 'blank', 'raw_material');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_units" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(40),
	"name_ar" varchar(60) NOT NULL,
	"name_en" varchar(60),
	"allows_fraction" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_units_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_attribute_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(40),
	"name_ar" varchar(80) NOT NULL,
	"name_en" varchar(80),
	"display" "catalog_attribute_display" DEFAULT 'text' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_attribute_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_attribute_values" (
	"id" serial PRIMARY KEY NOT NULL,
	"attribute_type_id" integer NOT NULL,
	"value_ar" varchar(80) NOT NULL,
	"value_en" varchar(80),
	"value_normalized" varchar(80) NOT NULL,
	"color_hex" varchar(7),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(60),
	"parent_id" integer,
	"level" smallint NOT NULL,
	"name_ar" varchar(120) NOT NULL,
	"name_en" varchar(120),
	"product_kind" "catalog_product_kind",
	"price_policy" "catalog_price_policy",
	"pricing_currency" "catalog_pricing_currency",
	"image_id" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_categories_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_category_attributes" (
	"category_id" integer NOT NULL,
	"attribute_type_id" integer NOT NULL,
	CONSTRAINT "catalog_category_attributes_category_id_attribute_type_id_pk" PRIMARY KEY("category_id","attribute_type_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_brands" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"name_normalized" varchar(120) NOT NULL,
	"logo_image_id" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_brands_name_normalized_unique" UNIQUE("name_normalized")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_attribute_values" ADD CONSTRAINT "catalog_attribute_values_attribute_type_id_catalog_attribute_types_id_fk" FOREIGN KEY ("attribute_type_id") REFERENCES "public"."catalog_attribute_types"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_categories" ADD CONSTRAINT "catalog_categories_parent_id_catalog_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."catalog_categories"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_categories" ADD CONSTRAINT "catalog_categories_image_id_media_assets_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_category_attributes" ADD CONSTRAINT "catalog_category_attributes_category_id_catalog_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."catalog_categories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_category_attributes" ADD CONSTRAINT "catalog_category_attributes_attribute_type_id_catalog_attribute_types_id_fk" FOREIGN KEY ("attribute_type_id") REFERENCES "public"."catalog_attribute_types"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalog_brands" ADD CONSTRAINT "catalog_brands_logo_image_id_media_assets_id_fk" FOREIGN KEY ("logo_image_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_attribute_values_type_normalized_unique" ON "catalog_attribute_values" USING btree ("attribute_type_id","value_normalized");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_attribute_values_type_idx" ON "catalog_attribute_values" USING btree ("attribute_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_categories_parent_idx" ON "catalog_categories" USING btree ("parent_id");