import { randomUUID } from "node:crypto";
import type { Analysis, AnalysisStore, CreateAnalysisInput, CreateFrameObservationInput, CreateTrackSegmentInput, FrameObservation, TrackSegment } from "./domain";

export class InMemoryAnalysisStore implements AnalysisStore {
  private readonly analyses = new Map<string, Analysis>();
  private readonly segments = new Map<string, TrackSegment[]>();
  private readonly observations = new Map<string, FrameObservation[]>();

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
    if (input.initialBox) {
      await this.createTrackSegment({ analysisId: analysis.id, startFrame: 0, initialBox: input.initialBox });
    }
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
  async createTrackSegment(input: CreateTrackSegmentInput): Promise<TrackSegment> {
    const segment: TrackSegment = {
      id: randomUUID(),
      analysisId: input.analysisId,
      startFrame: input.startFrame,
      initialBox: input.initialBox,
      createdAt: new Date().toISOString(),
    };
    this.segments.set(input.analysisId, [...(this.segments.get(input.analysisId) ?? []), segment]);
    return segment;
  }
  async listTrackSegments(analysisId: string): Promise<TrackSegment[]> {
    return this.segments.get(analysisId) ?? [];
  }
  async createFrameObservation(input: CreateFrameObservationInput): Promise<FrameObservation> {
    const observation: FrameObservation = {
      id: randomUUID(),
      analysisId: input.analysisId,
      segmentId: input.segmentId,
      frameNumber: input.frameNumber,
      timestampMs: input.timestampMs,
      quality: input.quality,
      box: input.box ?? null,
      observationFilePath: input.observationFilePath,
      qualityArtifactPath: input.qualityArtifactPath,
      createdAt: new Date().toISOString(),
    };
    this.observations.set(input.analysisId, [...(this.observations.get(input.analysisId) ?? []), observation]);
    return observation;
  }
  async listFrameObservations(analysisId: string): Promise<FrameObservation[]> {
    return this.observations.get(analysisId) ?? [];
  }
}
