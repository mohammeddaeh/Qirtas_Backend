ALTER TYPE "public"."finance_entry_type" ADD VALUE 'cash_rounding';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fx_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"buy_rate" numeric(14, 4) NOT NULL,
	"sell_rate" numeric(14, 4) NOT NULL,
	"note" text,
	"set_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_entries" ADD COLUMN "currency" varchar(3) DEFAULT 'SYP' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_entries" ADD COLUMN "amount_fx" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "finance_entries" ADD COLUMN "fx_rate" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "tendered_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "fx_rate" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "change_syp" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "cash_round_syp" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "currency" varchar(3) DEFAULT 'SYP' NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "amount_fx" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "fx_rate" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD COLUMN "opening_suggested_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD COLUMN "opening_counted_usd" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD COLUMN "counted_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD COLUMN "left_in_drawer_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD COLUMN "expected_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD COLUMN "difference_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD COLUMN "close_fx_rate" numeric(14, 4);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fx_rates_created_idx" ON "fx_rates" USING btree ("created_at");--> statement-breakpoint
-- The first rates start from the catalog's pricing rate — the manager writes the real buy/sell the first morning.
INSERT INTO "fx_rates" ("buy_rate", "sell_rate", "note")
SELECT "usd_to_syp", "usd_to_syp", 'initial — from the pricing rate'
FROM "catalog_exchange_rates"
WHERE NOT EXISTS (SELECT 1 FROM "fx_rates")
ORDER BY "effective_at" DESC
LIMIT 1;
