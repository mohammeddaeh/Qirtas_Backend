ALTER TABLE "branches" ADD COLUMN "name_en" varchar(150);--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "code" varchar(6);--> statement-breakpoint
UPDATE "branches" SET "code" = 'BR' || "id" WHERE "code" IS NULL;--> statement-breakpoint
ALTER TABLE "branches" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_returns" ADD COLUMN "policy" jsonb;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "goods_returns_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "print_returns_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "beyond_window_action" varchar(10) DEFAULT 'approve' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "print_return_window_days" integer;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "refund_cash_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "refund_credit_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "approval_above_syp" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "return_reason_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "damaged_returns_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "print_refund_suggest_percent" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branches_code_unique_idx" ON "branches" USING btree ("code");