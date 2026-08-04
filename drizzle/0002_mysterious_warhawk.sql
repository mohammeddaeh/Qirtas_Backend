CREATE TABLE IF NOT EXISTS "languages" (
	"code" varchar(10) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"is_rtl" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "translation_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"language_code" varchar(10) NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "translation_entries" ADD CONSTRAINT "translation_entries_language_code_languages_code_fk" FOREIGN KEY ("language_code") REFERENCES "public"."languages"("code") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "translation_entries_language_key_unique_idx" ON "translation_entries" USING btree ("language_code","key");