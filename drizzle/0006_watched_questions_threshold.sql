-- Migration: add per-question threshold column to watched_questions
-- threshold is nullable; null means "use the global SPREAD_THRESHOLD default (0.03)"
-- Valid range enforced at the application layer; CHECK constraint documents intent.
ALTER TABLE `watched_questions` ADD `threshold` real;
