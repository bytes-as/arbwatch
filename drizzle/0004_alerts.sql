CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`user_id` text NOT NULL,
	`state` text NOT NULL,
	`last_alerted_at` integer,
	`last_alerted_spread` real,
	FOREIGN KEY (`question_id`) REFERENCES `watched_questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `alerts_state_check` CHECK(`state` IN ('armed', 'fired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_question_id_unique` ON `alerts` (`question_id`);
