CREATE TABLE `tracking_recoveries` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`correction_set_id` text NOT NULL,
	`frame` integer NOT NULL,
	`seconds` real NOT NULL,
	`box` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`correction_set_id`) REFERENCES `correction_sets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `processing_runs` ADD `tracking_frame` integer DEFAULT -1 NOT NULL;