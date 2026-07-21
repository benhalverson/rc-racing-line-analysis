import type { CorrectionSet, LocalVideoRef, VideoStorage } from "../../shared/calibration-contract";

export type AnalysisState =
  | "draft"
  | "awaiting_calibration"
  | "ready"
  | "queued"
  | "running"
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
