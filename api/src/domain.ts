import type { CorrectionSet, LocalVideoRef, VideoStorage } from "../../shared/calibration-contract";

export type AnalysisState =
  | "draft"
  | "awaiting_calibration"
  | "ready"
  | "queued"
  | "running"
  | "needs_correction"
  | "completed"
  | "failed"
  | "cancelled";

export type ProcessingPhase = "created" | "calibrating" | "tracking" | "review";

export interface Analysis {
  id: string;
  videoPath: string;
  videoName: string;
  carDescription: string | null;
  state: AnalysisState;
  phase: ProcessingPhase;
  progress: number;
  checkpoint: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  videoStorage?: VideoStorage;
  localVideoRef?: LocalVideoRef;
  acceptedCorrectionSetId?: string | null;
}

export interface AnalysisStore {
  createDraft(input: CreateAnalysisInput): Promise<Analysis>;
  appendAcceptedCorrectionSet?(analysisId: string, payload: Omit<CorrectionSet, 'id' | 'analysisId' | 'version' | 'accepted' | 'createdAt'>, expected: { updatedAt: string; acceptedCorrectionSetId: string | null }): Promise<CorrectionSet>;
  listAnalyses?(): Promise<Analysis[]>;
  selectCorrectionSet?(analysisId: string, correctionSetId: string, expected: { updatedAt: string; acceptedCorrectionSetId: string | null }): Promise<Analysis>;
  get(id: string): Promise<Analysis | undefined>;
  save(analysis: Analysis): Promise<void>;
  createCorrectionSet(analysisId: string, payload: Omit<CorrectionSet, "id" | "analysisId" | "version" | "accepted" | "createdAt">): Promise<CorrectionSet>;
  listCorrectionSets(analysisId: string): Promise<CorrectionSet[]>;
  acceptCorrectionSet(analysisId: string, correctionSetId: string): Promise<CorrectionSet>;
}

export interface CreateAnalysisInput {
  videoPath: string;
  videoName: string;
  carDescription?: string;
  videoStorage?: VideoStorage;
  localVideoRef?: LocalVideoRef;
}
