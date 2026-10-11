DROP TABLE "station_pairing_codes" CASCADE;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "kind" varchar(16) DEFAULT 'till' NOT NULL;--> statement-breakpoint
-- «Sign in from a phone» (docs/reference/stations.md, user decision 2026-10-11):
-- every role held phone access before this permission existed, so every role —
-- seeded or created by the administration — gets it now. Nothing changes on
-- deploy; the administration takes it away from whom it chooses.
INSERT INTO "permissions" ("key", "module", "is_sensitive") VALUES ('stations.phone_sign_in', 'stations', false) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_key") SELECT "id", 'stations.phone_sign_in' FROM "roles" ON CONFLICT DO NOTHING;
