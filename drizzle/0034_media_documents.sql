ALTER TABLE "media_assets" ALTER COLUMN "width" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "height" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "status" varchar(12) DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "document_type" varchar(10);--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "mime_type" varchar(120);--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "uploaded_by_customer_id" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "delete_reason" varchar(30);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_customer_id_customers_id_fk" FOREIGN KEY ("uploaded_by_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_expiry_idx" ON "media_assets" USING btree ("expires_at") WHERE "media_assets"."status" IN ('pending', 'ready');--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_one_uploader" CHECK ("media_assets"."uploaded_by_user_id" IS NULL OR "media_assets"."uploaded_by_customer_id" IS NULL);