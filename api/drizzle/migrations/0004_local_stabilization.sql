CREATE TABLE `local_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`run_id` text NOT NULL,
	`correction_set_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `processing_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`correction_set_id`) REFERENCES `correction_sets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `processing_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`correction_set_id` text NOT NULL,
	`provider_version` text NOT NULL,
	`status` text NOT NULL,
	`frame` integer DEFAULT -1 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`correction_set_id`) REFERENCES `correction_sets`(`id`) ON UPDATE no action ON DELETE no action
);
