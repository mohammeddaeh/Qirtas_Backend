CREATE TABLE IF NOT EXISTS "import_staging" (
	"token" varchar(40) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"resource" varchar(64) NOT NULL,
	"rows" jsonb NOT NULL,
	"row_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_staging" ADD CONSTRAINT "import_staging_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_staging_expires_idx" ON "import_staging" USING btree ("expires_at");