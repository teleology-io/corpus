ALTER TABLE "slack_conversation" ADD COLUMN "remote_latest_ts" text;--> statement-breakpoint
ALTER TABLE "slack_conversation" ADD COLUMN "slack_last_read" text;--> statement-breakpoint
ALTER TABLE "slack_conversation" ADD COLUMN "checked_at" timestamp with time zone;