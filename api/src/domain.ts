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

export type TrackingQuality = "tracked" | "suspect" | "lost" | "reacquired";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrackSegment {
  id: string;
  analysisId: string;
  startFrame: number;
  initialBox: BoundingBox;
  createdAt: string;
}

export interface FrameObservation {
  id: string;
  analysisId: string;
  segmentId: string;
  frameNumber: number;
  timestampMs: number;
  quality: TrackingQuality;
  box: BoundingBox | null;
  observationFilePath: string;
  qualityArtifactPath: string;
  createdAt: string;
}

export interface AnalysisStore {
  createDraft(input: CreateAnalysisInput): Promise<Analysis>;
  get(id: string): Promise<Analysis | undefined>;
  save(analysis: Analysis): Promise<void>;
  createTrackSegment(input: CreateTrackSegmentInput): Promise<TrackSegment>;
  listTrackSegments(analysisId: string): Promise<TrackSegment[]>;
  createFrameObservation(input: CreateFrameObservationInput): Promise<FrameObservation>;
  listFrameObservations(analysisId: string): Promise<FrameObservation[]>;
}

export interface CreateAnalysisInput {
  videoPath: string;
  videoName: string;
  carDescription?: string;
  initialBox?: BoundingBox;
}

export interface CreateTrackSegmentInput {
  analysisId: string;
  startFrame: number;
  initialBox: BoundingBox;
}

export interface CreateFrameObservationInput {
  analysisId: string;
  segmentId: string;
  frameNumber: number;
  timestampMs: number;
  quality: TrackingQuality;
  box?: BoundingBox;
  observationFilePath: string;
  qualityArtifactPath: string;
}
