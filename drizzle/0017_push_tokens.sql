CREATE TABLE IF NOT EXISTS "device_push_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"realm" "account_realm" NOT NULL,
	"account_id" integer NOT NULL,
	"token" varchar(512) NOT NULL,
	"platform" varchar(16) NOT NULL,
	"language" varchar(8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_push_tokens_token_uq" ON "device_push_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_push_tokens_account_idx" ON "device_push_tokens" USING btree ("realm","account_id");