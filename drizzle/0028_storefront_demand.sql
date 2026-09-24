CREATE TYPE "public"."storefront_demand_kind" AS ENUM('notify', 'request_here');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storefront_demand" (
	"id" serial PRIMARY KEY NOT NULL,
	"variant_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"kind" "storefront_demand_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storefront_demand" ADD CONSTRAINT "storefront_demand_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storefront_demand" ADD CONSTRAINT "storefront_demand_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storefront_demand" ADD CONSTRAINT "storefront_demand_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "storefront_demand_once" ON "storefront_demand" USING btree ("customer_id","variant_id","branch_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storefront_demand_branch_idx" ON "storefront_demand" USING btree ("branch_id","variant_id");