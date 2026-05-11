-- Migration: add push_subscriptions table for web-push notification transport (Phase 2 v1.5)
-- Each row represents one active browser push subscription for a user.
-- ON DELETE CASCADE ensures subscriptions are removed when the user is deleted.
-- Unique constraint on (user_id, endpoint) prevents duplicate subscriptions.
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	UNIQUE(`user_id`, `endpoint`)
);
