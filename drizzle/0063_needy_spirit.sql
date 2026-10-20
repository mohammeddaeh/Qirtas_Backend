CREATE TYPE "public"."expense_category_kind" AS ENUM('operating', 'salary');--> statement-breakpoint
CREATE TYPE "public"."expense_source" AS ENUM('drawer', 'outside');--> statement-breakpoint
CREATE TYPE "public"."salary_kind" AS ENUM('salary', 'advance');--> statement-breakpoint
CREATE TYPE "public"."wage_frequency" AS ENUM('monthly', 'weekly', 'daily');--> statement-breakpoint
ALTER TYPE "public"."finance_doc_type" ADD VALUE 'expense';--> statement-breakpoint
ALTER TYPE "public"."finance_entry_type" ADD VALUE 'expense';--> statement-breakpoint
ALTER TYPE "public"."finance_method" ADD VALUE 'external';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_wages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"amount_syp" numeric(14, 2) NOT NULL,
	"frequency" "wage_frequency" DEFAULT 'monthly' NOT NULL,
	"due_day" integer DEFAULT 1 NOT NULL,
	"effective_from" date NOT NULL,
	"ended_on" date,
	"note" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expense_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name_ar" varchar(80) NOT NULL,
	"name_en" varchar(80),
	"kind" "expense_category_kind" DEFAULT 'operating' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	"amount_syp" numeric(14, 2) NOT NULL,
	"source" "expense_source" NOT NULL,
	"spent_on" date NOT NULL,
	"note" text,
	"receipt_media_id" integer,
	"employee_user_id" integer,
	"salary_kind" "salary_kind",
	"period" varchar(7),
	"recurring_id" integer,
	"cash_movement_id" integer,
	"shift_id" integer,
	"reverses_expense_id" integer,
	"created_by_user_id" integer,
	"station_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurring_expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	"amount_syp" numeric(14, 2) NOT NULL,
	"day_of_month" integer NOT NULL,
	"note" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employee_wages" ADD CONSTRAINT "employee_wages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employee_wages" ADD CONSTRAINT "employee_wages_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employee_wages" ADD CONSTRAINT "employee_wages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expenses" ADD CONSTRAINT "expenses_employee_user_id_users_id_fk" FOREIGN KEY ("employee_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_wages_user_idx" ON "employee_wages" USING btree ("user_id","effective_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_branch_day_idx" ON "expenses" USING btree ("branch_id","spent_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_employee_idx" ON "expenses" USING btree ("employee_user_id","period");--> statement-breakpoint
INSERT INTO "expense_categories" ("name_ar", "name_en", "kind", "sort_order") VALUES
('إيجار', 'Rent', 'operating', 1),
('رواتب وأجور', 'Salaries & wages', 'salary', 2),
('كهرباء وماء', 'Electricity & water', 'operating', 3),
('إنترنت واتصالات', 'Internet & phone', 'operating', 4),
('نقل ومواصلات', 'Transport', 'operating', 5),
('صيانة', 'Maintenance', 'operating', 6),
('ضيافة', 'Hospitality', 'operating', 7),
('قرطاسية المحل', 'Shop supplies', 'operating', 8),
('أخرى', 'Other', 'operating', 99);
