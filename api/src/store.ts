import { randomUUID } from "node:crypto";
import type { Analysis, AnalysisStore, CreateAnalysisInput } from "./domain.js";

export class InMemoryAnalysisStore implements AnalysisStore {
  private readonly analyses = new Map<string, Analysis>();

  async createDraft(input: CreateAnalysisInput): Promise<Analysis> {
    const now = new Date().toISOString();
    const analysis: Analysis = {
      id: randomUUID(),
      videoPath: input.videoPath,
      videoName: input.videoName,
      carDescription: input.carDescription ?? null,
      state: "draft",
      phase: "created",
      progress: 0,
      checkpoint: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.analyses.set(analysis.id, analysis);
    return analysis;
  }

  async get(id: string): Promise<Analysis | undefined> {
    return this.analyses.get(id);
  }
  async save(analysis: Analysis): Promise<void> {
    this.analyses.set(analysis.id, {
      ...analysis,
      updatedAt: new Date().toISOString(),
    });
  }
}
