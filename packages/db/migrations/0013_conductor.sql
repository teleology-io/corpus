CREATE TABLE "conductor_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"column" text DEFAULT 'inbox' NOT NULL,
	"planned_for" text,
	"chat_id" text,
	"pr_url" text,
	"note" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conductor_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"card_id" uuid,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"actor" text DEFAULT 'you' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conductor_card" ADD CONSTRAINT "conductor_card_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conductor_card" ADD CONSTRAINT "conductor_card_item_id_integration_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."integration_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conductor_event" ADD CONSTRAINT "conductor_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conductor_event" ADD CONSTRAINT "conductor_event_card_id_conductor_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."conductor_card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conductor_card_item_unique" ON "conductor_card" USING btree ("user_id","item_id");--> statement-breakpoint
CREATE INDEX "conductor_card_user_idx" ON "conductor_card" USING btree ("user_id","column");--> statement-breakpoint
CREATE INDEX "conductor_event_user_idx" ON "conductor_event" USING btree ("user_id","at");