import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Analysis, AnalysisStore, CreateAnalysisInput } from "./domain.js";

export class SqliteAnalysisStore implements AnalysisStore {
  private readonly db: DatabaseSync;
  constructor(path = "./data/analysis.sqlite") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, video_path TEXT NOT NULL, video_name TEXT NOT NULL, car_description TEXT, state TEXT NOT NULL, phase TEXT NOT NULL, progress REAL NOT NULL, checkpoint TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
  }
  createDraft(input: CreateAnalysisInput): Analysis {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO analyses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        input.videoPath,
        input.videoName,
        input.carDescription ?? null,
        "draft",
        "created",
        0,
        null,
        null,
        now,
        now,
      );
    return this.get(id)!;
  }
  get(id: string): Analysis | undefined {
    const row = this.db
      .prepare("SELECT * FROM analyses WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row
      ? {
          id: row.id as string,
          videoPath: row.video_path as string,
          videoName: row.video_name as string,
          carDescription: row.car_description as string | null,
          state: row.state as Analysis["state"],
          phase: row.phase as Analysis["phase"],
          progress: row.progress as number,
          checkpoint: row.checkpoint as string | null,
          error: row.error as string | null,
          createdAt: row.created_at as string,
          updatedAt: row.updated_at as string,
        }
      : undefined;
  }
  save(a: Analysis): void {
    this.db
      .prepare(
        "UPDATE analyses SET state=?, phase=?, progress=?, checkpoint=?, error=?, updated_at=? WHERE id=?",
      )
      .run(
        a.state,
        a.phase,
        a.progress,
        a.checkpoint,
        a.error,
        new Date().toISOString(),
        a.id,
      );
  }
}
