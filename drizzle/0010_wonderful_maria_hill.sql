CREATE TABLE IF NOT EXISTS "rate_limits" (
	"key" varchar(320) PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL
);
