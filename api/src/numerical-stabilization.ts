import type { MarkerObservation, MarkerTransformEstimator, Point, TransformCandidate, TransformModel } from './stabilization';

/** Applies an affine or projective image-to-reference transform. */
export function projectPoint(matrix: number[], point: Point): Point {
  const denominator = matrix.length === 9 ? matrix[6] * point.x + matrix[7] * point.y + matrix[8] : 1;
  return { x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator, y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator };
}

/** Solves an overdetermined system with pivoted elimination; singular geometry is rejected. */
function solve(rows: number[][], values: number[]): number[] | null {
  const size = rows[0].length;
  const normal = Array.from({ length: size }, (_, i) => Array.from({ length: size + 1 }, (_, j) => rows.reduce((sum, row, k) => sum + row[i] * (j === size ? values[k] : row[j]), 0)));
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) if (Math.abs(normal[row][column]) > Math.abs(normal[pivot][column])) pivot = row;
    if (Math.abs(normal[pivot][column]) < 1e-9) return null;
    [normal[column], normal[pivot]] = [normal[pivot], normal[column]];
    const divisor = normal[column][column];
    for (let j = column; j <= size; j++) normal[column][j] /= divisor;
    for (let row = 0; row < size; row++) if (row !== column) {
      const factor = normal[row][column];
      for (let j = column; j <= size; j++) normal[row][j] -= factor * normal[column][j];
    }
  }
  const result = normal.map(row => row[size]);
  return result.every(Number.isFinite) ? result : null;
}

/** Fits in normalized image coordinates to avoid pixel-scale conditioning errors. */
function fit(model: TransformModel, observations: MarkerObservation[], width: number, height: number): number[] | null {
  const rows: number[][] = []; const values: number[] = [];
  for (const observation of observations) {
    const x = observation.imagePoint.x / width; const y = observation.imagePoint.y / height;
    const u = observation.trackPoint.x / width; const v = observation.trackPoint.y / height;
    rows.push(model === 'affine' ? [x, y, 1, 0, 0, 0] : [x, y, 1, 0, 0, 0, -u * x, -u * y]); values.push(u);
    rows.push(model === 'affine' ? [0, 0, 0, x, y, 1] : [0, 0, 0, x, y, 1, -v * x, -v * y]); values.push(v);
  }
  const m = solve(rows, values); if (!m) return null;
  return model === 'affine' ? [m[0], m[1] * width / height, m[2] * width, m[3] * height / width, m[4], m[5] * height] : [m[0], m[1] * width / height, m[2] * width, m[3] * height / width, m[4], m[5] * height, m[6] / width, m[7] / height, 1];
}

/** Enumerates deterministic minimal samples with a bounded RANSAC budget. */
function samples(count: number, size: number): number[][] {
  const result: number[][] = [];
  /** Visits combinations in deterministic order. */
  function visit(prefix: number[], start: number): void {
    if (result.length >= 256) return;
    if (prefix.length === size) { result.push(prefix); return; }
    for (let index = start; index <= count - (size - prefix.length); index++) visit([...prefix, index], index + 1);
  }
  visit([], 0);
  // Seeded samples cover later identities when exhaustive combinations exceed the budget.
  let state = 0x12345678;
  for (let attempt = 0; attempt < 256 && count >= size; attempt++) {
    const indices = new Set<number>();
    while (indices.size < size) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; indices.add(state % count); }
    result.push([...indices].sort((a, b) => a - b));
  }
  return result;
}

/** Estimates robust transforms without remote services or native CV bindings. */
export class NumericalMarkerTransformEstimator implements MarkerTransformEstimator {
  /** Configures reference image dimensions and the pixel inlier threshold. */
  constructor(private readonly width: number, private readonly height: number, private readonly tolerance = 3) {}

  /** Fits minimal models, selects consensus, then refits on inliers. */
  estimate(model: TransformModel, observations: MarkerObservation[]): TransformCandidate {
    const minimum = model === 'affine' ? 3 : 4;
    const invalid: TransformCandidate = { matrix: [], reprojectionError: Number.MAX_VALUE, inlierCount: 0, scale: 0, rotationDegrees: 0, cropValid: false };
    if (observations.length < minimum || this.width <= 0 || this.height <= 0) return invalid;
    let inliers: MarkerObservation[] = []; let bestError = Infinity;
    for (const sample of samples(observations.length, minimum)) {
      const matrix = fit(model, sample.map(index => observations[index]), this.width, this.height); if (!matrix) continue;
      const accepted = observations.filter(observation => distance(projectPoint(matrix, observation.imagePoint), observation.trackPoint) <= this.tolerance);
      const error = accepted.reduce((sum, observation) => sum + distance(projectPoint(matrix, observation.imagePoint), observation.trackPoint), 0);
      if (accepted.length > inliers.length || (accepted.length === inliers.length && error < bestError)) { inliers = accepted; bestError = error; }
    }
    if (inliers.length < minimum) return invalid;
    const matrix = fit(model, inliers, this.width, this.height); if (!matrix) return invalid;
    const center = { x: this.width / 2, y: this.height / 2 }; const origin = projectPoint(matrix, center);
    const dx = projectPoint(matrix, { x: center.x + 1, y: center.y }); const dy = projectPoint(matrix, { x: center.x, y: center.y + 1 });
    const determinant = (dx.x - origin.x) * (dy.y - origin.y) - (dx.y - origin.y) * (dy.x - origin.x);
    const axisScales = [{ x: 0, y: 0 }, center, { x: this.width, y: 0 }, { x: 0, y: this.height }, { x: this.width, y: this.height }].flatMap(point => {
      const origin = projectPoint(matrix, point); const px = projectPoint(matrix, { x: point.x + 0.01, y: point.y }); const py = projectPoint(matrix, { x: point.x, y: point.y + 0.01 });
      const a = (px.x - origin.x) / 0.01; const b = (py.x - origin.x) / 0.01; const c = (px.y - origin.y) / 0.01; const d = (py.y - origin.y) / 0.01;
      const trace = a * a + b * b + c * c + d * d; const discriminant = Math.sqrt(Math.max(0, trace * trace - 4 * (a * d - b * c) ** 2));
      return [Math.sqrt(Math.max(0, (trace - discriminant) / 2)), Math.sqrt(Math.max(0, (trace + discriminant) / 2))];
    });
    const corners = [{ x: 0, y: 0 }, { x: this.width, y: 0 }, { x: this.width, y: this.height }, { x: 0, y: this.height }];
    const denominators = corners.map(point => matrix.length === 9 ? matrix[6] * point.x + matrix[7] * point.y + 1 : 1);
    // Require an orientation-preserving finite warp and at least 50% actual viewport overlap.
    const mapped = corners.map(point => projectPoint(matrix, point));
    const cropValid = determinant > 0 && denominators.every(value => value > 0.05) && mapped.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)) && clippedArea(mapped, this.width, this.height) >= this.width * this.height / 2;
    return { matrix, minimumAxisScale: Math.min(...axisScales), maximumAxisScale: Math.max(...axisScales), inlierCount: inliers.length, reprojectionError: Math.sqrt(inliers.reduce((sum, observation) => sum + distance(projectPoint(matrix, observation.imagePoint), observation.trackPoint) ** 2, 0) / inliers.length), scale: Math.sqrt(Math.abs(determinant)), rotationDegrees: Math.atan2(dx.y - origin.y, dx.x - origin.x) * 180 / Math.PI, cropValid };
  }
}

/** Returns Euclidean reprojection distance. */
function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }

/** Clips the warped image polygon to the reference viewport and measures real overlap. */
function clippedArea(points: Point[], width: number, height: number): number {
  let polygon = points;
  for (const [axis, boundary, direction] of [["x", 0, 1], ["x", width, -1], ["y", 0, 1], ["y", height, -1]] as const) {
    const clipped: Point[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index]; const b = polygon[(index + 1) % polygon.length];
      const insideA = (a[axis] - boundary) * direction >= 0; const insideB = (b[axis] - boundary) * direction >= 0;
      if (insideA) clipped.push(a);
      if (insideA !== insideB) { const t = (boundary - a[axis]) / (b[axis] - a[axis]); clipped.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }); }
    }
    polygon = clipped;
  }
  return Math.abs(polygon.reduce((sum, point, index) => { const next = polygon[(index + 1) % polygon.length]; return sum + point.x * next.y - point.y * next.x; }, 0)) / 2;
}
