PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_verification_tokens` (
	`identifier` text NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`identifier`, `token`)
);
--> statement-breakpoint
INSERT INTO `__new_verification_tokens`("identifier", "token", "expires") SELECT "identifier", "token", "expires" FROM `verification_tokens`;--> statement-breakpoint
DROP TABLE `verification_tokens`;--> statement-breakpoint
ALTER TABLE `__new_verification_tokens` RENAME TO `verification_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer,
	`created_at` integer NOT NULL,
	`anakin_key_ct` blob,
	`anakin_key_status` text DEFAULT 'key-missing' NOT NULL,
	`anakin_key_status_at` integer,
	CONSTRAINT "anakin_key_status_check" CHECK("__new_users"."anakin_key_status" IN ('ok', 'key-missing', 'key-invalid', 'quota-exhausted'))
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "email", "email_verified", "created_at", "anakin_key_ct", "anakin_key_status", "anakin_key_status_at") SELECT "id", "email", "email_verified", "created_at", "anakin_key_ct", "anakin_key_status", "anakin_key_status_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);