CREATE TABLE IF NOT EXISTS "doc_counters" (
	"stem" varchar(40) PRIMARY KEY NOT NULL,
	"last" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "numbering_formats" (
	"doc_type" varchar(20) PRIMARY KEY NOT NULL,
	"prefix" varchar(4) DEFAULT '' NOT NULL,
	"date_format" varchar(8) NOT NULL,
	"digits" smallint NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "print_ready_copies" ADD COLUMN "number" varchar(40);--> statement-breakpoint
-- Ready copies keep the number they were shown with (J-<id>); new ones are issued centrally.
UPDATE "print_ready_copies" SET "number" = 'J-' || lpad("id"::text, 4, '0') WHERE "number" IS NULL;--> statement-breakpoint
-- Every counter continues where the old numbering left it: the highest sequence
-- seen for each stem (the number without its trailing digits). A stem a new
-- format never produces is harmless; one it does produce cannot repeat a number.
INSERT INTO "doc_counters" ("stem", "last")
SELECT stem, MAX(seq) FROM (
  SELECT regexp_replace("number", '[0-9]+$', '') AS stem, CAST(substring("number" from '([0-9]+)$') AS integer) AS seq FROM "sales" WHERE "number" ~ '-[0-9]+$'
  UNION ALL SELECT regexp_replace("number", '[0-9]+$', ''), CAST(substring("number" from '([0-9]+)$') AS integer) FROM "sale_returns" WHERE "number" ~ '-[0-9]+$'
  UNION ALL SELECT regexp_replace("number", '[0-9]+$', ''), CAST(substring("number" from '([0-9]+)$') AS integer) FROM "orders" WHERE "number" ~ '-[0-9]+$'
  UNION ALL SELECT regexp_replace("number", '[0-9]+$', ''), CAST(substring("number" from '([0-9]+)$') AS integer) FROM "print_jobs" WHERE "number" ~ '-[0-9]+$'
  UNION ALL SELECT regexp_replace("number", '[0-9]+$', ''), CAST(substring("number" from '([0-9]+)$') AS integer) FROM "purchase_invoices" WHERE "number" ~ '-[0-9]+$'
  UNION ALL SELECT regexp_replace("number", '[0-9]+$', ''), CAST(substring("number" from '([0-9]+)$') AS integer) FROM "purchase_returns" WHERE "number" ~ '-[0-9]+$'
  UNION ALL SELECT regexp_replace("number", '[0-9]+$', ''), CAST(substring("number" from '([0-9]+)$') AS integer) FROM "stock_adjustments" WHERE "number" ~ '-[0-9]+$'
  UNION ALL SELECT regexp_replace("number", '[0-9]+$', ''), CAST(substring("number" from '([0-9]+)$') AS integer) FROM "stock_transfers" WHERE "number" ~ '-[0-9]+$'
  UNION ALL SELECT regexp_replace("number", '[0-9]+$', ''), CAST(substring("number" from '([0-9]+)$') AS integer) FROM "stock_counts" WHERE "number" ~ '-[0-9]+$'
) AS seen
WHERE length(stem) <= 40
GROUP BY stem
ON CONFLICT ("stem") DO UPDATE SET "last" = GREATEST("doc_counters"."last", EXCLUDED."last");
