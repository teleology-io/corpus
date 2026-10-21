CREATE TABLE "telescope_video" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"file_key" text NOT NULL,
	"upload_id" text,
	"thumb_key" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"link_token" text,
	"transcript" jsonb,
	"transcript_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telescope_video_link_token_unique" UNIQUE("link_token")
);
--> statement-breakpoint
CREATE TABLE "telescope_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"viewer_key" text NOT NULL,
	"viewer_user_id" text,
	"watched_ms" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telescope_video" ADD CONSTRAINT "telescope_video_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telescope_video" ADD CONSTRAINT "telescope_video_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telescope_view" ADD CONSTRAINT "telescope_view_video_id_telescope_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."telescope_video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telescope_view" ADD CONSTRAINT "telescope_view_viewer_user_id_user_id_fk" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telescope_video_owner_idx" ON "telescope_video" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "telescope_video_status_idx" ON "telescope_video" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "telescope_view_viewer_uq" ON "telescope_view" USING btree ("video_id","viewer_key");