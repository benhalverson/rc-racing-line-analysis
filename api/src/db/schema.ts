import { real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
});
