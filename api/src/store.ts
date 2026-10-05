import { randomUUID } from "node:crypto";
import type { Analysis, AnalysisStore, CreateAnalysisInput } from "./domain";
import type { CorrectionSet } from "../../shared/calibration-contract";

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
      videoStorage: input.videoStorage ?? "browser-sqlite",
      localVideoRef: input.localVideoRef ?? { id: input.videoPath.replace(/^browser-sqlite:\/\//, ""), name: input.videoName, mimeType: "video/*", size: 0, lastModified: 0 },
      acceptedCorrectionSetId: null,
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
  async createCorrectionSet(analysisId: string, payload: Omit<CorrectionSet, "id" | "analysisId" | "version" | "accepted" | "createdAt">): Promise<CorrectionSet> {
    const analysis = await this.get(analysisId);
    if (!analysis) throw new Error("analysis not found");
    const versions = [...this.correctionSets.values()].filter((set) => set.analysisId === analysisId);
    const set: CorrectionSet = { ...payload, id: randomUUID(), analysisId, version: versions.length + 1, accepted: false, createdAt: new Date().toISOString() };
    this.correctionSets.set(set.id, set);
    return set;
  }
  async listCorrectionSets(analysisId: string) { return [...this.correctionSets.values()].filter((set) => set.analysisId === analysisId).sort((a, b) => b.version - a.version); }
  async acceptCorrectionSet(analysisId: string, correctionSetId: string) {
    const set = this.correctionSets.get(correctionSetId);
    if (!set || set.analysisId !== analysisId) throw new Error("correction set not found");
    for (const item of this.correctionSets.values()) if (item.analysisId === analysisId) item.accepted = item.id === correctionSetId;
    const analysis = await this.get(analysisId);
    if (!analysis) throw new Error("analysis not found");
    await this.save({ ...analysis, state: "ready", phase: "calibrating", acceptedCorrectionSetId: correctionSetId });
    return { ...set, accepted: true };
  }
  private readonly correctionSets = new Map<string, CorrectionSet>();
}
