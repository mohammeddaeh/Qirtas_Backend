CREATE TABLE IF NOT EXISTS "account_mfa_recovery_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"realm" "account_realm" NOT NULL,
	"account_id" integer NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_mfa" (
	"realm" "account_realm" NOT NULL,
	"account_id" integer NOT NULL,
	"secret_sealed" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" integer,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_mfa_realm_account_id_pk" PRIMARY KEY("realm","account_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_mfa_recovery_lookup_idx" ON "account_mfa_recovery_codes" USING btree ("realm","account_id");