PRAGMA foreign_keys=OFF;
CREATE TABLE `timing_laps_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `import_id` text NOT NULL REFERENCES `timing_imports`(`id`) ON DELETE CASCADE,
  `lap_number` integer NOT NULL, `lap_time_seconds` real, `lap_time_text` text NOT NULL, `valid` integer, `status_text` text
);
INSERT INTO `timing_laps_new` SELECT `id`, `import_id`, `lap_number`, `lap_time_seconds`, `lap_time_text`, `valid`, `status_text` FROM `timing_laps`;
DROP TABLE `timing_laps`;
ALTER TABLE `timing_laps_new` RENAME TO `timing_laps`;
CREATE INDEX `timing_laps_import_id_idx` ON `timing_laps` (`import_id`);
PRAGMA foreign_keys=ON;
