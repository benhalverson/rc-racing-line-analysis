import type { MarkerObservation, TransformModel, TransformCandidate, TrackTransform, StabilizationArtifacts } from "../../shared/stabilization-contract";
export * from "../../shared/stabilization-contract";

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
  /** Configures observations, numerical estimation and quality limits. */
  constructor(
    private readonly observations: MarkerObservation[],
    private readonly estimator: MarkerTransformEstimator,
    private readonly thresholds: StabilizationThresholds = defaults,
    private readonly expectedFrames?: number[],
  ) {}

  /** Estimates ordered transforms and preserves explicit missing-observation frames. */
  async stabilize(): Promise<StabilizationArtifacts> {
    const groups = groupByFrame(this.observations);
    for (const frame of this.expectedFrames ?? []) if (!groups.has(frame)) groups.set(frame, []);
    const transforms = [...groups].sort(([a], [b]) => a - b).map(([frame, observations]) => this.estimateTransform(frame, observations));
    return { markerObservations: this.observations, transforms };
  }

  /** Escalates only a reprojection failure with enough projective evidence. */
  private estimateTransform(frame: number, observations: MarkerObservation[]): TrackTransform {
    const affine = this.estimate("affine", frame, observations);
    if ((!affine.quality.reprojectionValid || !affine.quality.inliersValid) && affine.quality.scaleValid && affine.quality.rotationValid && affine.quality.cropValid && distinctMarkerCount(observations) >= 5) {
      const projective = this.estimate("homography", frame, observations);
      if (projective.quality.usable) return projective;
    }
    return affine;
  }

  /** Applies finite matrix, geometry and diagnostic gates before downstream use. */
  private estimate(model: TransformModel, frame: number, observations: MarkerObservation[]): TrackTransform {
    const filtered = observations.filter(observation => Number.isInteger(observation.frame) && observation.frame >= 0 && observation.confidence >= 0.5 && observation.confidence <= 1 && [observation.imagePoint.x, observation.imagePoint.y, observation.trackPoint.x, observation.trackPoint.y].every(Number.isFinite));
    const unique = filtered.filter((observation) => filtered.filter(other => other.markerId === observation.markerId).length === 1);
    const candidate = this.estimator.estimate(model, unique);
    const matrixValid = candidate.matrix.length === (model === "affine" ? 6 : 9) && candidate.matrix.every(Number.isFinite);
    const enoughMarkers = distinctMarkerCount(unique) >= (model === "affine" ? 3 : 4);
    const qualitySignals = {
      enoughMarkers,
      reprojectionValid: matrixValid && Number.isFinite(candidate.reprojectionError) && candidate.reprojectionError >= 0 && candidate.reprojectionError <= this.thresholds.maximumReprojectionError,
      inliersValid: Number.isInteger(candidate.inlierCount) && candidate.inlierCount <= unique.length && candidate.inlierCount >= Math.max(this.thresholds.minimumInliers, model === "affine" ? 3 : 5, Math.ceil(unique.length * 0.8)),
      scaleValid: (candidate.minimumAxisScale ?? candidate.scale) >= this.thresholds.minimumScale && (candidate.maximumAxisScale ?? candidate.scale) <= this.thresholds.maximumScale,
      rotationValid: Math.abs(candidate.rotationDegrees) <= this.thresholds.maximumRotationDegrees,
      cropValid: candidate.cropValid,
    };
    const quality = { ...qualitySignals, usable: Object.values(qualitySignals).every(Boolean) };
    const { matrix, ...diagnostics } = candidate;
    return { frame, model, matrix, quality, diagnostics };
  }
}

/** Groups finite nonnegative frame indices for stable ordering. */
function groupByFrame(observations: MarkerObservation[]): Map<number, MarkerObservation[]> {
  const frames = new Map<number, MarkerObservation[]>();
  for (const observation of observations) {
    if (!Number.isInteger(observation.frame) || observation.frame < 0) throw new Error("Invalid marker frame index");
    const frameObservations = frames.get(observation.frame);
    if (frameObservations) frameObservations.push(observation);
    else frames.set(observation.frame, [observation]);
  }
  return frames;
}

/** Counts accepted identities independently of repeated observations. */
function distinctMarkerCount(observations: MarkerObservation[]): number {
  return new Set(observations.map(({ markerId }) => markerId)).size;
}
