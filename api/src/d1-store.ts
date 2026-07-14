import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { analyses, frameObservations, trackSegments } from "./db/schema";
import type { Analysis, AnalysisStore, CreateAnalysisInput, CreateFrameObservationInput, CreateTrackSegmentInput, FrameObservation, TrackSegment } from "./domain";

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

const trackSegmentRowSchema = z.object({
  id: z.string(),
  analysisId: z.string(),
  startFrame: z.number().int().nonnegative(),
  boxX: z.number(),
  boxY: z.number(),
  boxWidth: z.number().positive(),
  boxHeight: z.number().positive(),
  createdAt: z.string(),
});

const frameObservationRowSchema = z.object({
  id: z.string(),
  analysisId: z.string(),
  segmentId: z.string(),
  frameNumber: z.number().int().nonnegative(),
  timestampMs: z.number().int().nonnegative(),
  quality: z.enum(["tracked", "suspect", "lost", "reacquired"]),
  boxX: z.number().nullable(),
  boxY: z.number().nullable(),
  boxWidth: z.number().nullable(),
  boxHeight: z.number().nullable(),
  observationFilePath: z.string(),
  qualityArtifactPath: z.string(),
  createdAt: z.string(),
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
    if (input.initialBox) {
      await this.createTrackSegment({ analysisId: id, startFrame: 0, initialBox: input.initialBox });
    }
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

  async createTrackSegment(input: CreateTrackSegmentInput): Promise<TrackSegment> {
    const createdAt = new Date().toISOString();
    const id = crypto.randomUUID();
    await this.db.insert(trackSegments).values({
      id,
      analysisId: input.analysisId,
      startFrame: input.startFrame,
      boxX: input.initialBox.x,
      boxY: input.initialBox.y,
      boxWidth: input.initialBox.width,
      boxHeight: input.initialBox.height,
      createdAt,
    }).run();
    return { id, analysisId: input.analysisId, startFrame: input.startFrame, initialBox: input.initialBox, createdAt };
  }

  async listTrackSegments(analysisId: string): Promise<TrackSegment[]> {
    const rows = await this.db.select().from(trackSegments).where(eq(trackSegments.analysisId, analysisId)).orderBy(asc(trackSegments.startFrame)).all();
    return rows.map((row) => trackSegment(trackSegmentRowSchema.parse(row)));
  }

  async createFrameObservation(input: CreateFrameObservationInput): Promise<FrameObservation> {
    const createdAt = new Date().toISOString();
    const id = crypto.randomUUID();
    await this.db.insert(frameObservations).values({
      id,
      analysisId: input.analysisId,
      segmentId: input.segmentId,
      frameNumber: input.frameNumber,
      timestampMs: input.timestampMs,
      quality: input.quality,
      boxX: input.box?.x ?? null,
      boxY: input.box?.y ?? null,
      boxWidth: input.box?.width ?? null,
      boxHeight: input.box?.height ?? null,
      observationFilePath: input.observationFilePath,
      qualityArtifactPath: input.qualityArtifactPath,
      createdAt,
    }).run();
    return { id, analysisId: input.analysisId, segmentId: input.segmentId, frameNumber: input.frameNumber, timestampMs: input.timestampMs, quality: input.quality, box: input.box ?? null, observationFilePath: input.observationFilePath, qualityArtifactPath: input.qualityArtifactPath, createdAt };
  }

  async listFrameObservations(analysisId: string): Promise<FrameObservation[]> {
    const rows = await this.db.select().from(frameObservations).where(eq(frameObservations.analysisId, analysisId)).orderBy(asc(frameObservations.frameNumber)).all();
    return rows.map((row) => frameObservation(frameObservationRowSchema.parse(row)));
  }
}

function trackSegment(row: z.infer<typeof trackSegmentRowSchema>): TrackSegment {
  return { id: row.id, analysisId: row.analysisId, startFrame: row.startFrame, initialBox: { x: row.boxX, y: row.boxY, width: row.boxWidth, height: row.boxHeight }, createdAt: row.createdAt };
}

function frameObservation(row: z.infer<typeof frameObservationRowSchema>): FrameObservation {
  const box = row.boxX === null || row.boxY === null || row.boxWidth === null || row.boxHeight === null
    ? null
    : { x: row.boxX, y: row.boxY, width: row.boxWidth, height: row.boxHeight };
  return { id: row.id, analysisId: row.analysisId, segmentId: row.segmentId, frameNumber: row.frameNumber, timestampMs: row.timestampMs, quality: row.quality, box, observationFilePath: row.observationFilePath, qualityArtifactPath: row.qualityArtifactPath, createdAt: row.createdAt };
}
