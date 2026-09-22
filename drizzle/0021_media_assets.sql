CREATE TABLE IF NOT EXISTS "media_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"zone" varchar(10) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"key_base" varchar(200) NOT NULL,
	"original_filename" varchar(255),
	"original_bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"variants" jsonb NOT NULL,
	"uploaded_by_user_id" integer,
	"attached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_key_base_unique" UNIQUE("key_base")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
