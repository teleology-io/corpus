ALTER TABLE "pr_review" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "pr_review" ADD COLUMN "previous" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_review" ADD COLUMN "approved_url" text;