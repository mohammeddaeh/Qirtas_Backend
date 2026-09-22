CREATE TABLE IF NOT EXISTS "session_tombstones" (
	"id" serial PRIMARY KEY NOT NULL,
	"realm" "account_realm" NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"reason" varchar(32) NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_tombstones_realm_hash_uq" ON "session_tombstones" USING btree ("realm","token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_tombstones_expires_idx" ON "session_tombstones" USING btree ("expires_at");