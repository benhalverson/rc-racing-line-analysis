CREATE TABLE IF NOT EXISTS `timing_imports` (
  `id` text PRIMARY KEY NOT NULL, `source` text NOT NULL, `track_host` text NOT NULL, `track_name` text NOT NULL, `track_url` text NOT NULL,
  `event_name` text NOT NULL, `event_url` text NOT NULL, `race_id` text, `race_label` text NOT NULL, `round_label` text NOT NULL,
  `class_label` text NOT NULL, `race_url` text NOT NULL, `driver_name` text NOT NULL, `normalized_driver_name` text NOT NULL,
  `driver_id` text, `fetched_at` text NOT NULL, `parser_version` text NOT NULL, `source_hash` text NOT NULL
);
CREATE TABLE IF NOT EXISTS `timing_laps` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `import_id` text NOT NULL, `lap_number` integer NOT NULL, `lap_time_seconds` real,
  `lap_time_text` text NOT NULL, `valid` integer, `status_text` text
);
