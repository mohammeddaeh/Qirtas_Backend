CREATE TABLE IF NOT EXISTS "data_transfer_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"resource" varchar(64) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"user_id" integer,
	"station_id" integer,
	"file_name" varchar(200),
	"format" varchar(8),
	"row_count" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_staging" ADD COLUMN "file_name" varchar(200);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_transfer_runs" ADD CONSTRAINT "data_transfer_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_transfer_runs" ADD CONSTRAINT "data_transfer_runs_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_transfer_runs_resource_created_idx" ON "data_transfer_runs" USING btree ("resource","created_at");