CREATE TABLE `alternative_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`alternative_id` text NOT NULL,
	`analysis_id` text NOT NULL,
	`run_id` text NOT NULL,
	`correction_set_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`track_reference_id` text NOT NULL,
	`review_version` integer NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `processing_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`correction_set_id`) REFERENCES `correction_sets`(`id`) ON UPDATE no action ON DELETE no action
);
