CREATE TABLE "slack_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text,
	"thread_ts" text NOT NULL,
	"permalink" text,
	"preview" text,
	"author_name" text,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"latest_ts" text,
	"last_read_ts" text,
	"mention_ts" text,
	"followed" boolean DEFAULT true NOT NULL,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "calendar" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "calendar" ADD COLUMN "sync_token" text;--> statement-breakpoint
ALTER TABLE "calendar" ADD COLUMN "read_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "external_etag" text;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "external_meta" jsonb;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "sync_dirty" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_thread" ADD CONSTRAINT "slack_thread_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_thread_unique" ON "slack_thread" USING btree ("connection_id","channel_id","thread_ts");--> statement-breakpoint
CREATE INDEX "slack_thread_activity_idx" ON "slack_thread" USING btree ("connection_id","last_activity_at");--> statement-breakpoint
ALTER TABLE "calendar" ADD CONSTRAINT "calendar_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_external_unique" ON "calendar" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_external_unique" ON "event" USING btree ("calendar_id","external_id");