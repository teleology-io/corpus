ALTER TABLE "conductor_card" ALTER COLUMN "item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conductor_card" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "conductor_card" ADD COLUMN "body" text;