-- Migration: add embedding column to watched_questions and match_score to question_matches
-- watched_questions.embedding stores the L2-normalized Float32Array (1536d × 4 = 6144 bytes)
-- question_matches.match_score stores the cosine similarity from the embedding matcher
ALTER TABLE `watched_questions` ADD `embedding` blob;
--> statement-breakpoint
ALTER TABLE `question_matches` ADD `match_score` real;
