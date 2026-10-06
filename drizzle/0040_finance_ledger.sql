CREATE TYPE "public"."finance_doc_type" AS ENUM('sale', 'sale_return', 'stock_adjustment', 'print_job', 'print_counter', 'ready_copy');--> statement-breakpoint
CREATE TYPE "public"."finance_entry_type" AS ENUM('sale_revenue', 'cogs', 'print_materials', 'refund', 'cogs_reversal', 'loss_damaged_return', 'loss_print_return', 'print_waste', 'ready_shelf_in', 'ready_shelf_out', 'loss_ready_writeoff', 'loss_inventory');--> statement-breakpoint
CREATE TYPE "public"."finance_method" AS ENUM('cash', 'card', 'customer_credit', 'on_account', 'value');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finance_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"type" "finance_entry_type" NOT NULL,
	"method" "finance_method" NOT NULL,
	"amount_syp" numeric(14, 2) NOT NULL,
	"doc_type" "finance_doc_type" NOT NULL,
	"doc_id" integer NOT NULL,
	"sale_id" integer,
	"user_id" integer,
	"reason" varchar(40),
	"note" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_entries_branch_time_idx" ON "finance_entries" USING btree ("branch_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_entries_type_time_idx" ON "finance_entries" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_entries_doc_idx" ON "finance_entries" USING btree ("doc_type","doc_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_entries_sale_idx" ON "finance_entries" USING btree ("sale_id");