CREATE TYPE "public"."print_job_status" AS ENUM('draft', 'awaiting_quote', 'awaiting_payment', 'queued', 'in_production', 'ready', 'picked_up', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."print_payment_status" AS ENUM('unpaid', 'paid', 'deferred');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_job_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"media_asset_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_job_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"url" text NOT NULL,
	"note" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_job_sequences" (
	"branch_id" integer NOT NULL,
	"year" smallint NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "print_job_sequences_branch_id_year_pk" PRIMARY KEY("branch_id","year")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" varchar(40),
	"sequence" integer,
	"branch_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"status" "print_job_status" DEFAULT 'draft' NOT NULL,
	"payment_status" "print_payment_status" DEFAULT 'unpaid' NOT NULL,
	"paper_size_id" integer NOT NULL,
	"color_mode_id" integer NOT NULL,
	"sides_id" integer NOT NULL,
	"binding_id" integer NOT NULL,
	"cover_id" integer NOT NULL,
	"copies" integer DEFAULT 1 NOT NULL,
	"note" text,
	"total_pages" integer,
	"quote" jsonb,
	"quoted_total_syp" numeric(14, 2),
	"quoted_by" integer,
	"quoted_at" timestamp with time zone,
	"payment_due_at" timestamp with time zone,
	"cancel_reason" text,
	"cancelled_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"production_started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "print_settings" ADD COLUMN "unpaid_timeout_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_job_files" ADD CONSTRAINT "print_job_files_job_id_print_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."print_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_job_files" ADD CONSTRAINT "print_job_files_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_job_links" ADD CONSTRAINT "print_job_links_job_id_print_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."print_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_job_sequences" ADD CONSTRAINT "print_job_sequences_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_paper_size_id_print_options_id_fk" FOREIGN KEY ("paper_size_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_color_mode_id_print_options_id_fk" FOREIGN KEY ("color_mode_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_sides_id_print_options_id_fk" FOREIGN KEY ("sides_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_binding_id_print_options_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_cover_id_print_options_id_fk" FOREIGN KEY ("cover_id") REFERENCES "public"."print_options"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_quoted_by_users_id_fk" FOREIGN KEY ("quoted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "print_job_files_asset_once" ON "print_job_files" USING btree ("media_asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_job_files_job_idx" ON "print_job_files" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_job_links_job_idx" ON "print_job_links" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "print_jobs_number_once" ON "print_jobs" USING btree ("branch_id","number") WHERE "print_jobs"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_queue_idx" ON "print_jobs" USING btree ("branch_id","status","submitted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_customer_idx" ON "print_jobs" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_due_idx" ON "print_jobs" USING btree ("status","payment_due_at");