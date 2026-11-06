CREATE TABLE "pr_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"tree_sha" text,
	"status" text DEFAULT 'running' NOT NULL,
	"slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"not_reviewed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"posted_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pr_review" ADD CONSTRAINT "pr_review_item_id_integration_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."integration_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review" ADD CONSTRAINT "pr_review_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_item_head_unique" ON "pr_review" USING btree ("item_id","head_sha");--> statement-breakpoint
CREATE INDEX "pr_review_user_idx" ON "pr_review" USING btree ("user_id","created_at");