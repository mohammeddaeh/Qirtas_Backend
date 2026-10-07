ALTER TABLE "print_jobs" ADD COLUMN "reprint_of" integer;--> statement-breakpoint
ALTER TABLE "print_ready_sales" ADD COLUMN "customer_id" integer;--> statement-breakpoint
ALTER TABLE "print_ready_sales" ADD COLUMN "contact_name" varchar(120);--> statement-breakpoint
ALTER TABLE "print_ready_sales" ADD COLUMN "contact_phone" varchar(32);