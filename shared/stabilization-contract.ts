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
  minimumAxisScale?: number;
  maximumAxisScale?: number;
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
  seconds?: number;
  model: TransformModel;
  matrix: number[];
  quality: TransformQuality;
  diagnostics?: Omit<TransformCandidate, "matrix">;
};

export type StabilizationArtifacts = {
  coordinateSystem?: "reference-pixels";
  totalFrames?: number;
  referenceSize?: { width: number; height: number };
  markerObservations: MarkerObservation[];
  transforms: TrackTransform[];
};


/** Rejects unusable regions before mapping downstream car observations. */
export function transformUsablePoint(transform: TrackTransform, point: Point): Point | null {
  if (!transform.quality.usable || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const m = transform.matrix; const denominator = m.length === 9 ? m[6] * point.x + m[7] * point.y + m[8] : 1;
  const result = { x: (m[0] * point.x + m[1] * point.y + m[2]) / denominator, y: (m[3] * point.x + m[4] * point.y + m[5]) / denominator };
  return Number.isFinite(result.x) && Number.isFinite(result.y) && denominator > 0.05 ? result : null;
}
