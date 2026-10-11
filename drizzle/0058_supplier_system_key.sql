ALTER TABLE "suppliers" ADD COLUMN "system_key" varchar(32);--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_system_key_unique" UNIQUE("system_key");