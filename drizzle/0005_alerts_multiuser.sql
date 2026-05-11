-- Migration: change alerts unique constraint from (question_id) to (question_id, user_id)
-- Required for multi-user support: each user has independent hysteresis state per question.
DROP INDEX IF EXISTS `alerts_question_id_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_question_id_user_id_unique` ON `alerts` (`question_id`, `user_id`);
