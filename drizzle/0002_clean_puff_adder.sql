CREATE TABLE `question_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`platform` text NOT NULL,
	`market_id` text NOT NULL,
	`market_url` text,
	`implied_yes_prob` real,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `watched_questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_matches_question_id_platform_unique` ON `question_matches` (`question_id`,`platform`);