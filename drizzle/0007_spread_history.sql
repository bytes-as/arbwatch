-- Migration: add spread_history append-only table for 7-day sparkline (Phase 2 v1.5)
-- Each cron tick appends one row per watched question.
-- ON DELETE CASCADE ensures rows are removed when the parent watched_question is deleted.
-- Retention: rows older than 8 days pruned by the cron handler after each full sweep.
CREATE TABLE `spread_history` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`spread` real,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `watched_questions`(`id`) ON UPDATE no action ON DELETE cascade
);
