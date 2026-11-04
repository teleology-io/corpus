CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "calendar_feed_token_idx" ON "calendar" USING btree ("feed_token");--> statement-breakpoint
CREATE INDEX "event_ws_single_end_idx" ON "event" USING btree ("workspace_id","ends_at") WHERE "event"."rrule" is null and "event"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "event_ws_recurring_idx" ON "event" USING btree ("workspace_id","starts_at") WHERE "event"."rrule" is not null and "event"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "event_title_trgm_idx" ON "event" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "task_title_trgm_idx" ON "task" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "note_workspace_archived_idx" ON "note" USING btree ("workspace_id","archived_at");--> statement-breakpoint
CREATE INDEX "note_title_trgm_idx" ON "note" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "note_content_trgm_idx" ON "note" USING gin ("content_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "note_share_team_idx" ON "note_share" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "notification_unread_idx" ON "notification" USING btree ("user_id") WHERE "notification"."read_at" is null;--> statement-breakpoint
CREATE INDEX "integration_item_open_idx" ON "integration_item" USING btree ("connection_id","external_updated_at") WHERE "integration_item"."resolved_at" is null;