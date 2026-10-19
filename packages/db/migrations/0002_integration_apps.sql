CREATE TABLE "integration_app" (
	"provider" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_connection" ADD COLUMN "auth_type" text DEFAULT 'oauth' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_app" ADD CONSTRAINT "integration_app_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;