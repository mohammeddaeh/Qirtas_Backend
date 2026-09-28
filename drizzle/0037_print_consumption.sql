CREATE TYPE "public"."print_consumption_basis" AS ENUM('per_sheet', 'per_printed_page', 'per_copy', 'per_job');--> statement-breakpoint
ALTER TYPE "public"."inventory_doc_type" ADD VALUE 'print_job';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_consumable_meters" (
	"branch_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"pending" numeric(18, 9) DEFAULT '0' NOT NULL,
	"since_install" numeric(18, 9) DEFAULT '0' NOT NULL,
	"pages_since_install" integer DEFAULT 0 NOT NULL,
	"installed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_consumable_meters_branch_id_variant_id_pk" PRIMARY KEY("branch_id","variant_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_consumable_reconciliations" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"baseline" boolean DEFAULT false NOT NULL,
	"estimated" numeric(18, 9) NOT NULL,
	"actual" numeric(14, 3) NOT NULL,
	"correction" numeric(14, 3) NOT NULL,
	"pages" integer NOT NULL,
	"suggested_yield_pages" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_consumption_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"option_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"basis" "print_consumption_basis" NOT NULL,
	"qty" numeric(14, 6),
	"yield_pages" integer,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_consumption_rules_qty_or_yield" CHECK (("print_consumption_rules"."qty" IS NOT NULL AND "print_consumption_rules"."qty" > 0 AND "print_consumption_rules"."yield_pages" IS NULL) OR ("print_consumption_rules"."qty" IS NULL AND "print_consumption_rules"."yield_pages" IS NOT NULL AND "print_consumption_rules"."yield_pages" > 0))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_job_consumption" (
	"job_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"qty" numeric(18, 9) NOT NULL,
	"unit_cost_syp" numeric(14, 2) NOT NULL,
	"cost_syp" numeric(14, 2) NOT NULL,
	CONSTRAINT "print_job_consumption_job_id_variant_id_pk" PRIMARY KEY("job_id","variant_id")
);
--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "materials_cost_syp" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_consumable_meters" ADD CONSTRAINT "print_consumable_meters_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_consumable_meters" ADD CONSTRAINT "print_consumable_meters_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_consumable_reconciliations" ADD CONSTRAINT "print_consumable_reconciliations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_consumable_reconciliations" ADD CONSTRAINT "print_consumable_reconciliations_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_consumable_reconciliations" ADD CONSTRAINT "print_consumable_reconciliations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_consumption_rules" ADD CONSTRAINT "print_consumption_rules_option_id_print_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."print_options"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_consumption_rules" ADD CONSTRAINT "print_consumption_rules_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_consumption_rules" ADD CONSTRAINT "print_consumption_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_job_consumption" ADD CONSTRAINT "print_job_consumption_job_id_print_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."print_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_job_consumption" ADD CONSTRAINT "print_job_consumption_variant_id_catalog_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "print_consumption_rules_once" ON "print_consumption_rules" USING btree ("option_id","variant_id");