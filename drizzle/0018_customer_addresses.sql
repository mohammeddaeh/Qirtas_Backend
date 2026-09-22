CREATE TYPE "public"."address_kind" AS ENUM('home', 'work', 'other');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_addresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"kind" "address_kind" DEFAULT 'home' NOT NULL,
	"label" varchar(50),
	"recipient_name" varchar(200),
	"recipient_phone" varchar(32),
	"area" varchar(200) DEFAULT '' NOT NULL,
	"details" text NOT NULL,
	"landmark" varchar(255),
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_addresses_coords_chk" CHECK (("customer_addresses"."latitude" IS NULL) = ("customer_addresses"."longitude" IS NULL) AND ("customer_addresses"."latitude" IS NULL OR ("customer_addresses"."latitude" BETWEEN -90 AND 90 AND "customer_addresses"."longitude" BETWEEN -180 AND 180)))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_addresses_customer_idx" ON "customer_addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_addresses_one_default_uq" ON "customer_addresses" USING btree ("customer_id") WHERE "customer_addresses"."is_default";--> statement-breakpoint
-- Carry every existing free-text address over as that customer's default, BEFORE
-- the column goes. The old text had no area/details split, so it lands in
-- `details` and `area` stays empty until the customer next edits the row.
INSERT INTO "customer_addresses" ("customer_id", "kind", "details", "is_default")
SELECT "id", 'home', btrim("address"), true FROM "customers"
WHERE "address" IS NOT NULL AND btrim("address") <> '';--> statement-breakpoint
ALTER TABLE "customers" DROP COLUMN IF EXISTS "address";