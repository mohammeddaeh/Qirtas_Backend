-- ============================================================================
-- Authentication engine (core/auth) — 2026-08-11
--
-- Hand-edited after generation. drizzle-kit produced the structure correctly
-- but could not know three things, each of which would have failed or silently
-- corrupted state:
--
--  1. `sessions.token_hash` and `sessions.expires_at` are NOT NULL with no
--     default, and the table has rows — the bare ADD COLUMN aborts. The rows
--     are deleted first (see below), which is the accepted consequence of
--     hashing the token, not an accident.
--  2. Existing users must be backfilled as verified, or every account in the
--     system would appear unverified the moment this deploys.
--  3. Nothing else in this file may reference 'pending_verification':
--     PostgreSQL permits ALTER TYPE ... ADD VALUE inside a transaction (v12+)
--     but forbids *using* the new value before that transaction commits.
-- ============================================================================

CREATE TYPE "public"."verification_purpose" AS ENUM('email_verify', 'password_reset');--> statement-breakpoint
ALTER TYPE "public"."user_status" ADD VALUE 'pending_verification';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "auth_verification_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"purpose" "verification_purpose" NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- A failed sign-in against an address that does not exist has no actor, and it
-- is the single most alert-worthy row this table can hold. NOT NULL made that
-- row unstorable.
ALTER TABLE "audit_log_entries" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint

-- ── Backfill: every pre-existing account counts as verified ──────────────────
--
-- Not a convenience. These accounts were created under a system that never
-- asked for proof of address, so treating them as unverified would not be
-- "discovering" that they are — it would be inventing a fact and, with
-- EMAIL_VERIFICATION_MODE=required, stranding 69 working accounts behind a code
-- nobody ever sent them. Verification applies from here forward.
--
-- `created_at`, not `now()`: the timestamp is a claim about when the address
-- was trusted, and these were trusted from the day they were made. Stamping
-- them all with the deploy time would put a false spike in the record.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;--> statement-breakpoint

ALTER TABLE "users" DROP COLUMN IF EXISTS "password_reset_token";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "password_reset_expires_at";--> statement-breakpoint

-- ── Sessions: plaintext tokens become digests ────────────────────────────────
--
-- Existing sessions CANNOT be migrated. Hashing them in place would require
-- reading the plaintext, which is exactly the value this change exists to stop
-- storing — and a session table that keeps working is one whose contents were
-- never at risk in the first place.
--
-- So every current session ends and everyone signs in once more. That is the
-- price of the fix, paid once, and it is the reason this statement is explicit
-- rather than left as a surprising side effect of an ADD COLUMN failure.
DELETE FROM "sessions";--> statement-breakpoint

ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_token_unique";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "token";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "token_hash" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "provider" varchar(32) DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_rotated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash");--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "auth_verification_tokens" ADD CONSTRAINT "auth_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_verification_tokens_user_purpose_idx" ON "auth_verification_tokens" USING btree ("user_id","purpose","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_expires_idx" ON "sessions" USING btree ("expires_at");
