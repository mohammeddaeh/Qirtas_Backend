ALTER TABLE "sessions" ADD COLUMN "token" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_unique" UNIQUE("token");