ALTER TABLE "audit_log_entries" ADD COLUMN "station_id" integer;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "station_id" integer;--> statement-breakpoint
ALTER TABLE "sale_returns" ADD COLUMN "station_id" integer;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "started_station_id" integer;