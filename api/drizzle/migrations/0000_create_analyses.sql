CREATE TABLE IF NOT EXISTS `analyses` (
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
	`updated_at` text NOT NULL
);
