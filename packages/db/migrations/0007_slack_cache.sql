CREATE TABLE "slack_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"dm_user_id" text,
	"topic" text,
	"is_member" boolean DEFAULT true NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"latest_ts" text,
	"oldest_ts" text,
	"has_older" boolean DEFAULT true NOT NULL,
	"last_read_ts" text,
	"last_opened_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"inaccessible_code" text,
	"inaccessible_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"ts" text NOT NULL,
	"thread_ts" text,
	"ts_num" double precision NOT NULL,
	"user_id" text,
	"bot_name" text,
	"text" text DEFAULT '' NOT NULL,
	"subtype" text,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"latest_reply" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edited_ts" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_rate_limit" (
	"connection_id" uuid NOT NULL,
	"method" text NOT NULL,
	"tokens" double precision NOT NULL,
	"per_minute" double precision NOT NULL,
	"refilled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "slack_user" (
	"connection_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_connection" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_conversation" ADD CONSTRAINT "slack_conversation_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_message" ADD CONSTRAINT "slack_message_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_rate_limit" ADD CONSTRAINT "slack_rate_limit_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user" ADD CONSTRAINT "slack_user_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_conversation_unique" ON "slack_conversation" USING btree ("connection_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_message_unique" ON "slack_message" USING btree ("connection_id","channel_id","ts");--> statement-breakpoint
CREATE INDEX "slack_message_channel_idx" ON "slack_message" USING btree ("connection_id","channel_id","ts_num");--> statement-breakpoint
CREATE INDEX "slack_message_thread_idx" ON "slack_message" USING btree ("connection_id","channel_id","thread_ts","ts_num");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_rate_limit_unique" ON "slack_rate_limit" USING btree ("connection_id","method");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_unique" ON "slack_user" USING btree ("connection_id","user_id");