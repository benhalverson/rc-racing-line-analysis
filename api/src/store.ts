import { randomUUID } from "node:crypto";
import type { Analysis, AnalysisStore, CreateAnalysisInput } from "./domain.js";

export class InMemoryAnalysisStore implements AnalysisStore {
  private readonly analyses = new Map<string, Analysis>();

  createDraft(input: CreateAnalysisInput): Analysis {
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

  get(id: string): Analysis | undefined {
    return this.analyses.get(id);
  }
  save(analysis: Analysis): void {
    this.analyses.set(analysis.id, {
      ...analysis,
      updatedAt: new Date().toISOString(),
    });
  }
}
