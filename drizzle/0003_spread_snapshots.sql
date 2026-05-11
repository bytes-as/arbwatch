CREATE TABLE `spread_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`spread` real,
	`last_updated` integer NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `watched_questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spread_snapshots_question_id_unique` ON `spread_snapshots` (`question_id`);
