CREATE TYPE "public"."print_ready_status" AS ENUM('available', 'sold_out', 'written_off');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_ready_copies" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"label" varchar(120) NOT NULL,
	"status" "print_ready_status" DEFAULT 'available' NOT NULL,
	"paper_size_id" integer,
	"color_mode_id" integer,
	"sides_id" integer,
	"binding_id" integer,
	"cover_id" integer,
	"pages" integer,
	"copies_in" integer NOT NULL,
	"copies_available" integer NOT NULL,
	"unit_value_syp" numeric(14, 2) NOT NULL,
	"unit_price_syp" numeric(14, 2) NOT NULL,
	"source_return_id" integer,
	"source_sale_id" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_ready_sales" (
	"id" serial PRIMARY KEY NOT NULL,
	"ready_copy_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"status" varchar(10) DEFAULT 'open' NOT NULL,
	"sale_id" integer,
	"copies" integer NOT NULL,
	"unit_price_syp" numeric(14, 2) NOT NULL,
	"total_syp" numeric(14, 2) NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_ready_write_offs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ready_copy_id" integer NOT NULL,
	"copies" integer NOT NULL,
	"value_syp" numeric(14, 2) NOT NULL,
	"reason_code" varchar(20) NOT NULL,
	"note" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sale_return_lines" ALTER COLUMN "variant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_return_lines" ADD COLUMN "service_kind" varchar(20);--> statement-breakpoint
ALTER TABLE "sale_return_lines" ADD COLUMN "service_ref_id" integer;--> statement-breakpoint
ALTER TABLE "sale_return_lines" ADD COLUMN "disposition" varchar(12);--> statement-breakpoint
ALTER TABLE "sale_returns" ADD COLUMN "reason_code" varchar(20);--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "label" varchar(120);--> statement-breakpoint
ALTER TABLE "print_counter_sales" ADD COLUMN "label" varchar(120);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_ready_copies" ADD CONSTRAINT "print_ready_copies_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_ready_copies" ADD CONSTRAINT "print_ready_copies_paper_size_id_print_options_id_fk" FOREIGN KEY ("paper_size_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_ready_copies" ADD CONSTRAINT "print_ready_copies_color_mode_id_print_options_id_fk" FOREIGN KEY ("color_mode_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_ready_copies" ADD CONSTRAINT "print_ready_copies_sides_id_print_options_id_fk" FOREIGN KEY ("sides_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_ready_copies" ADD CONSTRAINT "print_ready_copies_binding_id_print_options_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_ready_copies" ADD CONSTRAINT "print_ready_copies_cover_id_print_options_id_fk" FOREIGN KEY ("cover_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_ready_copies" ADD CONSTRAINT "print_ready_copies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_ready_sales" ADD CONSTRAINT "print_ready_sales_ready_copy_id_print_ready_copies_id_fk" FOREIGN KEY ("ready_copy_id") REFERENCES "public"."print_ready_copies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_ready_sales" ADD CONSTRAINT "print_ready_sales_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_ready_write_offs" ADD CONSTRAINT "print_ready_write_offs_ready_copy_id_print_ready_copies_id_fk" FOREIGN KEY ("ready_copy_id") REFERENCES "public"."print_ready_copies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_ready_copies_branch_idx" ON "print_ready_copies" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_ready_sales_copy_idx" ON "print_ready_sales" USING btree ("ready_copy_id");