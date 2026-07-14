import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { analyses, correctionSets } from "./db/schema";
import type { CorrectionSet } from "../../shared/calibration-contract";
import type { Analysis, AnalysisStore, CreateAnalysisInput } from "./domain";

const analysisRowSchema = z.object({
  id: z.string(),
  videoPath: z.string(),
  videoName: z.string(),
  carDescription: z.string().nullable(),
  state: z.enum(["draft", "awaiting_calibration", "ready", "queued", "running", "completed", "failed", "cancelled"]),
  phase: z.enum(["created", "calibrating", "tracking", "review"]),
  progress: z.number().min(0).max(1),
  checkpoint: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  videoStorage: z.enum(["browser-sqlite", "legacy"]),
  localVideoRef: z.preprocess((value) => typeof value === "string" && value.trim() ? JSON.parse(value) : undefined, z.unknown().optional()),
  acceptedCorrectionSetId: z.string().nullable(),
});

export class D1AnalysisStore implements AnalysisStore {
  private readonly db;

  constructor(database: D1Database) {
    this.db = drizzle(database);
  }

  async createDraft(input: CreateAnalysisInput): Promise<Analysis> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await this.db.insert(analyses).values({ id, videoPath: `browser-sqlite://${input.localVideoRef?.id ?? input.videoPath}`, videoName: input.videoName, carDescription: input.carDescription ?? null, state: "draft", phase: "created", progress: 0, checkpoint: null, error: null, createdAt: now, updatedAt: now, videoStorage: "browser-sqlite", localVideoRef: JSON.stringify(input.localVideoRef ?? { id: input.videoPath, name: input.videoName, mimeType: "video/*", size: 0, lastModified: 0 }), acceptedCorrectionSetId: null }).run();
    const analysis = await this.get(id);
    if (!analysis) throw new Error("analysis was not persisted");
    return analysis;
  }

  async get(id: string): Promise<Analysis | undefined> {
    const row = await this.db.select().from(analyses).where(eq(analyses.id, id)).get();
    if (!row) return undefined;
    const parsed = analysisRowSchema.parse(row);
    return { ...parsed, localVideoRef: parsed.localVideoRef as Analysis['localVideoRef'] };
  }

  async save(analysis: Analysis): Promise<void> {
    await this.db.update(analyses).set({ state: analysis.state, phase: analysis.phase, progress: analysis.progress, checkpoint: analysis.checkpoint, error: analysis.error, acceptedCorrectionSetId: analysis.acceptedCorrectionSetId, updatedAt: new Date().toISOString() }).where(eq(analyses.id, analysis.id)).run();
  }
  async createCorrectionSet(analysisId: string, payload: Omit<CorrectionSet, "id" | "analysisId" | "version" | "accepted" | "createdAt">) {
    const existing = await this.db.select().from(correctionSets).where(eq(correctionSets.analysisId, analysisId)).all();
    const set: CorrectionSet = { ...payload, id: crypto.randomUUID(), analysisId, version: existing.length + 1, accepted: false, createdAt: new Date().toISOString() };
    await this.db.insert(correctionSets).values({ id: set.id, analysisId, version: set.version, payload: JSON.stringify(payload), accepted: false, createdAt: set.createdAt }).run();
    return set;
  }
  async listCorrectionSets(analysisId: string) {
    const rows = await this.db.select().from(correctionSets).where(eq(correctionSets.analysisId, analysisId)).all();
    return rows.sort((a, b) => b.version - a.version).map((row) => ({ ...JSON.parse(row.payload), id: row.id, analysisId, version: row.version, accepted: row.accepted, createdAt: row.createdAt } as CorrectionSet));
  }
  async acceptCorrectionSet(analysisId: string, correctionSetId: string) {
    const sets = await this.listCorrectionSets(analysisId);
    const set = sets.find((item) => item.id === correctionSetId);
    if (!set) throw new Error("correction set not found");
    await this.db.update(correctionSets).set({ accepted: false }).where(eq(correctionSets.analysisId, analysisId)).run();
    await this.db.update(correctionSets).set({ accepted: true }).where(eq(correctionSets.id, correctionSetId)).run();
    const analysis = await this.get(analysisId);
    if (!analysis) throw new Error("analysis not found");
    await this.save({ ...analysis, state: "ready", acceptedCorrectionSetId: correctionSetId });
    return { ...set, accepted: true };
  }
}
