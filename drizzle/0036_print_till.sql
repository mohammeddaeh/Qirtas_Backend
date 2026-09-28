ALTER TABLE "sale_lines" ALTER COLUMN "variant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_lines" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "service_kind" varchar(20);--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "service_ref_id" integer;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "sale_id" integer;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "deferred_by" integer;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "deferred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "deferred_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_deferred_by_users_id_fk" FOREIGN KEY ("deferred_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sale_lines_service_once" ON "sale_lines" USING btree ("sale_id","service_kind","service_ref_id") WHERE "sale_lines"."service_kind" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_goods_or_service" CHECK (("sale_lines"."variant_id" IS NOT NULL AND "sale_lines"."product_id" IS NOT NULL AND "sale_lines"."service_kind" IS NULL AND "sale_lines"."service_ref_id" IS NULL) OR ("sale_lines"."variant_id" IS NULL AND "sale_lines"."product_id" IS NULL AND "sale_lines"."service_kind" IS NOT NULL AND "sale_lines"."service_ref_id" IS NOT NULL));