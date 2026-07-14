CREATE TABLE IF NOT EXISTS `track_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL REFERENCES `analyses`(`id`) ON DELETE CASCADE,
	`start_frame` integer NOT NULL,
	`box_x` real NOT NULL,
	`box_y` real NOT NULL,
	`box_width` real NOT NULL,
	`box_height` real NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `frame_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL REFERENCES `analyses`(`id`) ON DELETE CASCADE,
	`segment_id` text NOT NULL REFERENCES `track_segments`(`id`) ON DELETE CASCADE,
	`frame_number` integer NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`quality` text NOT NULL,
	`box_x` real,
	`box_y` real,
	`box_width` real,
	`box_height` real,
	`observation_file_path` text NOT NULL,
	`quality_artifact_path` text NOT NULL,
	`created_at` text NOT NULL
);
