CREATE TYPE "public"."authz_override_effect" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "authz_user_permission_overrides" (
	"user_id" integer NOT NULL,
	"permission_key" varchar(100) NOT NULL,
	"effect" "authz_override_effect" NOT NULL,
	"note" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authz_user_permission_overrides_user_id_permission_key_pk" PRIMARY KEY("user_id","permission_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "authz_user_permission_overrides" ADD CONSTRAINT "authz_user_permission_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authz_overrides_user_idx" ON "authz_user_permission_overrides" USING btree ("user_id");