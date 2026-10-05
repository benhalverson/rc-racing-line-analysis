CREATE TABLE `review_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`run_id` text NOT NULL,
	`correction_set_id` text NOT NULL,
	`version` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `processing_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`correction_set_id`) REFERENCES `correction_sets`(`id`) ON UPDATE no action ON DELETE no action
);
