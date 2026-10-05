CREATE TABLE `analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`video_path` text NOT NULL,
	`video_name` text NOT NULL,
	`car_description` text,
	`state` text NOT NULL,
	`phase` text NOT NULL,
	`progress` real NOT NULL,
	`checkpoint` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`video_storage` text DEFAULT 'browser-sqlite' NOT NULL,
	`local_video_ref` text DEFAULT '{}' NOT NULL,
	`accepted_correction_set_id` text
);
--> statement-breakpoint
CREATE TABLE `correction_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`version` integer NOT NULL,
	`payload` text NOT NULL,
	`accepted` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `timing_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`track_host` text NOT NULL,
	`track_name` text NOT NULL,
	`track_url` text NOT NULL,
	`event_name` text NOT NULL,
	`event_url` text NOT NULL,
	`race_id` text,
	`race_label` text NOT NULL,
	`round_label` text NOT NULL,
	`class_label` text NOT NULL,
	`race_url` text NOT NULL,
	`driver_name` text NOT NULL,
	`normalized_driver_name` text NOT NULL,
	`driver_id` text,
	`fetched_at` text NOT NULL,
	`parser_version` text NOT NULL,
	`source_hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `timing_laps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` text NOT NULL,
	`lap_number` integer NOT NULL,
	`lap_time_seconds` real,
	`lap_time_text` text NOT NULL,
	`valid` integer,
	`status_text` text,
	FOREIGN KEY (`import_id`) REFERENCES `timing_imports`(`id`) ON UPDATE no action ON DELETE cascade
);
