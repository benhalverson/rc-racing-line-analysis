import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { analyses } from "./db/schema.js";
import type { Analysis, AnalysisStore, CreateAnalysisInput } from "./domain.js";

const analysisRowSchema = z.object({
  id: z.string(),
  videoPath: z.string(),
  videoName: z.string(),
  carDescription: z.string().nullable(),
  state: z.enum(["draft", "queued", "running", "completed", "failed", "cancelled"]),
  phase: z.enum(["created", "calibrating", "tracking", "review"]),
  progress: z.number().min(0).max(1),
  checkpoint: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class D1AnalysisStore implements AnalysisStore {
  private readonly db;

  constructor(database: D1Database) {
    this.db = drizzle(database);
  }

  async createDraft(input: CreateAnalysisInput): Promise<Analysis> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await this.db.insert(analyses).values({ id, videoPath: input.videoPath, videoName: input.videoName, carDescription: input.carDescription ?? null, state: "draft", phase: "created", progress: 0, checkpoint: null, error: null, createdAt: now, updatedAt: now }).run();
    const analysis = await this.get(id);
    if (!analysis) throw new Error("analysis was not persisted");
    return analysis;
  }

  async get(id: string): Promise<Analysis | undefined> {
    const row = await this.db.select().from(analyses).where(eq(analyses.id, id)).get();
    return row ? analysisRowSchema.parse(row) : undefined;
  }

  async save(analysis: Analysis): Promise<void> {
    await this.db.update(analyses).set({ state: analysis.state, phase: analysis.phase, progress: analysis.progress, checkpoint: analysis.checkpoint, error: analysis.error, updatedAt: new Date().toISOString() }).where(eq(analyses.id, analysis.id)).run();
  }
}
