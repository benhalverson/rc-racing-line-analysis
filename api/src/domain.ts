export type AnalysisState =
  | "draft"
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
}

export interface AnalysisStore {
  createDraft(input: CreateAnalysisInput): Promise<Analysis>;
  get(id: string): Promise<Analysis | undefined>;
  save(analysis: Analysis): Promise<void>;
}

export interface CreateAnalysisInput {
  videoPath: string;
  videoName: string;
  carDescription?: string;
}
