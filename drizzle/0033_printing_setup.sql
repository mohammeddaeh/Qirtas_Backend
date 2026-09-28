CREATE TYPE "public"."print_option_kind" AS ENUM('paper_size', 'color_mode', 'sides', 'binding', 'cover');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_branch_finishing_rates" (
	"branch_id" integer NOT NULL,
	"option_id" integer NOT NULL,
	"amount_syp" numeric(14, 2) NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_branch_finishing_rates_branch_id_option_id_pk" PRIMARY KEY("branch_id","option_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_branch_options" (
	"branch_id" integer NOT NULL,
	"option_id" integer NOT NULL,
	"is_enabled" boolean NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_branch_options_branch_id_option_id_pk" PRIMARY KEY("branch_id","option_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_branch_page_rates" (
	"branch_id" integer NOT NULL,
	"paper_size_id" integer NOT NULL,
	"color_mode_id" integer NOT NULL,
	"sides_id" integer NOT NULL,
	"amount_syp" numeric(14, 2) NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_branch_page_rates_branch_id_paper_size_id_color_mode_id_sides_id_pk" PRIMARY KEY("branch_id","paper_size_id","color_mode_id","sides_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_finishing_rates" (
	"option_id" integer PRIMARY KEY NOT NULL,
	"amount_syp" numeric(14, 2) NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "print_option_kind" NOT NULL,
	"code" varchar(32) NOT NULL,
	"name_ar" varchar(80) NOT NULL,
	"name_en" varchar(80),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_options_kind_code_uq" UNIQUE("kind","code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_page_rates" (
	"paper_size_id" integer NOT NULL,
	"color_mode_id" integer NOT NULL,
	"sides_id" integer NOT NULL,
	"amount_syp" numeric(14, 2) NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_page_rates_paper_size_id_color_mode_id_sides_id_pk" PRIMARY KEY("paper_size_id","color_mode_id","sides_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_quantity_tiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"min_pages" integer NOT NULL,
	"discount_percent" numeric(5, 2) NOT NULL,
	CONSTRAINT "print_quantity_tiers_min_pages_unique" UNIQUE("min_pages")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"branch_band_percent" numeric(5, 2) DEFAULT '20' NOT NULL,
	"file_retention_days" integer DEFAULT 30 NOT NULL,
	"max_file_mb" integer DEFAULT 50 NOT NULL,
	"max_pages" integer DEFAULT 2000 NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_branch_finishing_rates" ADD CONSTRAINT "print_branch_finishing_rates_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_branch_finishing_rates" ADD CONSTRAINT "print_branch_finishing_rates_option_id_print_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."print_options"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_branch_finishing_rates" ADD CONSTRAINT "print_branch_finishing_rates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_branch_options" ADD CONSTRAINT "print_branch_options_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_branch_options" ADD CONSTRAINT "print_branch_options_option_id_print_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."print_options"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_branch_options" ADD CONSTRAINT "print_branch_options_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_branch_page_rates" ADD CONSTRAINT "print_branch_page_rates_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_branch_page_rates" ADD CONSTRAINT "print_branch_page_rates_paper_size_id_print_options_id_fk" FOREIGN KEY ("paper_size_id") REFERENCES "public"."print_options"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_branch_page_rates" ADD CONSTRAINT "print_branch_page_rates_color_mode_id_print_options_id_fk" FOREIGN KEY ("color_mode_id") REFERENCES "public"."print_options"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_branch_page_rates" ADD CONSTRAINT "print_branch_page_rates_sides_id_print_options_id_fk" FOREIGN KEY ("sides_id") REFERENCES "public"."print_options"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_branch_page_rates" ADD CONSTRAINT "print_branch_page_rates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_finishing_rates" ADD CONSTRAINT "print_finishing_rates_option_id_print_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."print_options"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_finishing_rates" ADD CONSTRAINT "print_finishing_rates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_page_rates" ADD CONSTRAINT "print_page_rates_paper_size_id_print_options_id_fk" FOREIGN KEY ("paper_size_id") REFERENCES "public"."print_options"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_page_rates" ADD CONSTRAINT "print_page_rates_color_mode_id_print_options_id_fk" FOREIGN KEY ("color_mode_id") REFERENCES "public"."print_options"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_page_rates" ADD CONSTRAINT "print_page_rates_sides_id_print_options_id_fk" FOREIGN KEY ("sides_id") REFERENCES "public"."print_options"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_page_rates" ADD CONSTRAINT "print_page_rates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_settings" ADD CONSTRAINT "print_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_branch_page_rates_branch_idx" ON "print_branch_page_rates" USING btree ("branch_id");