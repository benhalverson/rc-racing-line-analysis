import type { NormalizedBox } from './calibration-contract';
import type { Point } from './stabilization-contract';

export type TrackingQuality = 'tracked' | 'suspect' | 'lost' | 'reacquired';
export type PixelBox = { x: number; y: number; width: number; height: number };
export type TrackingRecovery = { id: string; analysisId: string; correctionSetId: string; frame: number; seconds: number; box: NormalizedBox; createdAt: string };
export type CarObservation = {
  frame: number;
  seconds: number;
  segmentId: string | null;
  quality: TrackingQuality;
  box: PixelBox | null;
  trackPoint: Point | null;
  appearanceError: number | null;
  ambiguityMargin: number | null;
  reason: string;
};
export type TrackingArtifacts = {
  providerVersion: string;
  correctionSetId: string;
  referenceSize: { width: number; height: number };
  observations: CarObservation[];
  segments: Array<{ id: string; startFrame: number; seconds: number; box: PixelBox; source: 'selection' | 'manual' }>;
};
