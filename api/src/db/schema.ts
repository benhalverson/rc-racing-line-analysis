import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const analyses = sqliteTable("analyses", {
  id: text("id").primaryKey(),
  videoPath: text("video_path").notNull(),
  videoName: text("video_name").notNull(),
  carDescription: text("car_description"),
  state: text("state").notNull(),
  phase: text("phase").notNull(),
  progress: real("progress").notNull(),
  checkpoint: text("checkpoint"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  videoStorage: text("video_storage").notNull().default("browser-sqlite"),
  localVideoRef: text("local_video_ref").notNull().default("{}"),
  acceptedCorrectionSetId: text("accepted_correction_set_id"),
});

export const correctionSets = sqliteTable("correction_sets", {
  id: text("id").primaryKey(),
  analysisId: text("analysis_id").notNull().references(() => analyses.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  payload: text("payload").notNull(),
  accepted: integer("accepted", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export const timingImports = sqliteTable("timing_imports", {
  id: text("id").primaryKey(), source: text("source").notNull(), trackHost: text("track_host").notNull(), trackName: text("track_name").notNull(), trackUrl: text("track_url").notNull(), eventName: text("event_name").notNull(), eventUrl: text("event_url").notNull(), raceId: text("race_id"), raceLabel: text("race_label").notNull(), roundLabel: text("round_label").notNull(), classLabel: text("class_label").notNull(), raceUrl: text("race_url").notNull(), driverName: text("driver_name").notNull(), normalizedDriverName: text("normalized_driver_name").notNull(), driverId: text("driver_id"), fetchedAt: text("fetched_at").notNull(), parserVersion: text("parser_version").notNull(), sourceHash: text("source_hash").notNull(),
});

export const timingLaps = sqliteTable("timing_laps", {
  id: integer("id").primaryKey({ autoIncrement: true }), importId: text("import_id").notNull().references(() => timingImports.id, { onDelete: "cascade" }), lapNumber: integer("lap_number").notNull(), lapTimeSeconds: real("lap_time_seconds"), lapTimeText: text("lap_time_text").notNull(), valid: integer("valid"), statusText: text("status_text"),
});
