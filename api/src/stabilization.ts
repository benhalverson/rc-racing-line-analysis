export type Point = {
  x: number;
  y: number;
};

export type TransformModel = "affine" | "homography";

export type MarkerObservation = {
  frame: number;
  markerId: string;
  imagePoint: Point;
  trackPoint: Point;
  confidence: number;
};

export type TransformCandidate = {
  matrix: number[];
  reprojectionError: number;
  inlierCount: number;
  scale: number;
  rotationDegrees: number;
  cropValid: boolean;
};

export type TransformQuality = {
  enoughMarkers: boolean;
  reprojectionValid: boolean;
  inliersValid: boolean;
  scaleValid: boolean;
  rotationValid: boolean;
  cropValid: boolean;
  usable: boolean;
};

export type TrackTransform = {
  frame: number;
  model: TransformModel;
  matrix: number[];
  quality: TransformQuality;
};

export type StabilizationArtifacts = {
  markerObservations: MarkerObservation[];
  transforms: TrackTransform[];
};

export type StabilizationThresholds = {
  maximumReprojectionError: number;
  minimumInliers: number;
  minimumScale: number;
  maximumScale: number;
  maximumRotationDegrees: number;
};

export interface MarkerTransformEstimator {
  estimate(model: TransformModel, observations: MarkerObservation[]): TransformCandidate;
}

export interface MarkerStabilizationProvider {
  stabilize(): Promise<StabilizationArtifacts>;
}

const defaults: StabilizationThresholds = {
  maximumReprojectionError: 3,
  minimumInliers: 3,
  minimumScale: 0.5,
  maximumScale: 2,
  maximumRotationDegrees: 45,
};

export class MarkerBasedStabilizationProvider implements MarkerStabilizationProvider {
  constructor(
    private readonly observations: MarkerObservation[],
    private readonly estimator: MarkerTransformEstimator,
    private readonly thresholds: StabilizationThresholds = defaults,
  ) {}

  async stabilize(): Promise<StabilizationArtifacts> {
    const transforms = [...groupByFrame(this.observations)].map(([frame, observations]) =>
      this.estimateTransform(frame, observations),
    );
    return { markerObservations: this.observations, transforms };
  }

  private estimateTransform(frame: number, observations: MarkerObservation[]): TrackTransform {
    const affine = this.estimate("affine", frame, observations);
    if (!affine.quality.usable && distinctMarkerCount(observations) >= 4) {
      return this.estimate("homography", frame, observations);
    }
    return affine;
  }

  private estimate(model: TransformModel, frame: number, observations: MarkerObservation[]): TrackTransform {
    const candidate = this.estimator.estimate(model, observations);
    const enoughMarkers = distinctMarkerCount(observations) >= (model === "affine" ? 3 : 4);
    const qualitySignals = {
      enoughMarkers,
      reprojectionValid: candidate.reprojectionError <= this.thresholds.maximumReprojectionError,
      inliersValid: candidate.inlierCount >= this.thresholds.minimumInliers,
      scaleValid: candidate.scale >= this.thresholds.minimumScale && candidate.scale <= this.thresholds.maximumScale,
      rotationValid: Math.abs(candidate.rotationDegrees) <= this.thresholds.maximumRotationDegrees,
      cropValid: candidate.cropValid,
    };
    const quality = { ...qualitySignals, usable: Object.values(qualitySignals).every(Boolean) };
    return { frame, model, matrix: candidate.matrix, quality };
  }
}

function groupByFrame(observations: MarkerObservation[]): Map<number, MarkerObservation[]> {
  const frames = new Map<number, MarkerObservation[]>();
  for (const observation of observations) {
    const frameObservations = frames.get(observation.frame);
    if (frameObservations) frameObservations.push(observation);
    else frames.set(observation.frame, [observation]);
  }
  return frames;
}

function distinctMarkerCount(observations: MarkerObservation[]): number {
  return new Set(observations.map(({ markerId }) => markerId)).size;
}
