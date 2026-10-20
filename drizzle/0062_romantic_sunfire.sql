ALTER TYPE "public"."customer_ledger_reason" ADD VALUE 'debt_payment';--> statement-breakpoint
ALTER TABLE "customer_ledger_entries" ADD COLUMN "branch_id" integer;--> statement-breakpoint
ALTER TABLE "customer_ledger_entries" ADD COLUMN "reverses_entry_id" integer;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "credit_block_after_days" integer;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "overpay_to_credit_customers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "overpay_to_credit_suppliers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
UPDATE "customer_ledger_entries" e SET "branch_id" = s."branch_id" FROM "sales" s WHERE e."sale_id" = s."id" AND e."branch_id" IS NULL;
