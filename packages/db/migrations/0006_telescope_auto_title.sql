ALTER TABLE "telescope_video" ADD COLUMN "auto_titled_at" timestamp with time zone;--> statement-breakpoint
-- Auto titles are for new recordings: re-transcribing an old one must not replace its title.
UPDATE "telescope_video" SET "auto_titled_at" = now();
