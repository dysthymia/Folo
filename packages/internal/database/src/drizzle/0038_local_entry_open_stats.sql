CREATE TABLE `entry_open_stats` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`feed_id` text NOT NULL,
	`published_at` integer NOT NULL,
	`first_opened_at` integer,
	`open_source` text
);
--> statement-breakpoint
CREATE INDEX `idx_entry_open_stats_feed_published_at` ON `entry_open_stats` (`feed_id`,`published_at`);
--> statement-breakpoint
CREATE INDEX `idx_entry_open_stats_feed_first_opened_at` ON `entry_open_stats` (`feed_id`,`first_opened_at`);
--> statement-breakpoint
INSERT INTO `entry_open_stats` (`entry_id`, `feed_id`, `published_at`)
SELECT `id`, `feed_id`, `published_at`
FROM `entries`
WHERE `feed_id` IS NOT NULL AND `published_at` IS NOT NULL;
