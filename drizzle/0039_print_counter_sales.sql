CREATE TYPE "public"."print_counter_status" AS ENUM('open', 'settled', 'void');--> statement-breakpoint
ALTER TYPE "public"."inventory_doc_type" ADD VALUE 'print_counter';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_counter_sales" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"status" "print_counter_status" DEFAULT 'open' NOT NULL,
	"sale_id" integer,
	"paper_size_id" integer NOT NULL,
	"color_mode_id" integer NOT NULL,
	"sides_id" integer NOT NULL,
	"binding_id" integer NOT NULL,
	"cover_id" integer NOT NULL,
	"pages" integer NOT NULL,
	"copies" integer NOT NULL,
	"quote" jsonb NOT NULL,
	"total_syp" numeric(14, 2) NOT NULL,
	"materials_cost_syp" numeric(14, 2),
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_counter_sales" ADD CONSTRAINT "print_counter_sales_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_counter_sales" ADD CONSTRAINT "print_counter_sales_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_counter_sales" ADD CONSTRAINT "print_counter_sales_paper_size_id_print_options_id_fk" FOREIGN KEY ("paper_size_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_counter_sales" ADD CONSTRAINT "print_counter_sales_color_mode_id_print_options_id_fk" FOREIGN KEY ("color_mode_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_counter_sales" ADD CONSTRAINT "print_counter_sales_sides_id_print_options_id_fk" FOREIGN KEY ("sides_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_counter_sales" ADD CONSTRAINT "print_counter_sales_binding_id_print_options_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_counter_sales" ADD CONSTRAINT "print_counter_sales_cover_id_print_options_id_fk" FOREIGN KEY ("cover_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_counter_sales" ADD CONSTRAINT "print_counter_sales_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_counter_sales_sale_idx" ON "print_counter_sales" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_counter_sales_branch_idx" ON "print_counter_sales" USING btree ("branch_id","created_at");