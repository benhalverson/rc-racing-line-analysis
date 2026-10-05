import { connected, type RacingLineReview } from './review-contract';
import type { Point } from './stabilization-contract';

export const GEOMETRY_VERSION = 'reference-polyline-v1';
export type Geometry = { length: number; totalTurningRadians: number; meanCurvature: number | null; turnVariationRadians: number | null; corners: Array<{ entry: Point; apex: Point; exit: Point; turnRadians: number }>; segments: number; warnings: string[]; uncertainty: string };
export type AlternativeAuthority = { runId: string; correctionSetId: string; evidenceId: string; trackReferenceId: string; reviewVersion: number };
export type AlternativeVersion = AlternativeAuthority & { id: string; alternativeId: string; version: number; name: string; points: Point[]; createdAt: string; geometryVersion: string; hypothetical: true; geometry: Geometry };
export type AlternativeWorkspace = { authority: AlternativeAuthority; observed: Geometry; versions: Array<AlternativeVersion & { current: boolean }>; referenceSize: { width: number; height: number } };
export type AlternativeEdit = AlternativeAuthority & { alternativeId: string | null; baseVersion: number; name: string; points: Point[] };

/** Measures disconnected polylines without filling missing evidence or assigning timing. */
export function geometry(segments: Point[][], warnings: string[] = []): Geometry {
  let length = 0; let turning = 0; const turns: number[] = []; const corners: Geometry['corners'] = [];
  for (const points of segments) {
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1]; const b = points[i]; const c = points[i + 1];
      const ux = b.x - a.x; const uy = b.y - a.y; const vx = c.x - b.x; const vy = c.y - b.y;
      if (Math.hypot(ux, uy) < 1e-9 || Math.hypot(vx, vy) < 1e-9) continue;
      const turn = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      turning += Math.abs(turn); turns.push(turn);
      if (Math.abs(turn) >= Math.PI / 12) corners.push({ entry: a, apex: b, exit: c, turnRadians: turn });
    }
  }
  // Never compare turn changes across disconnected evidence intervals.
  let variation = 0; let pairs = 0;
  for (const points of segments) {
    let prior: number | undefined;
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1]; const b = points[i]; const c = points[i + 1];
      const ux = b.x - a.x; const uy = b.y - a.y; const vx = c.x - b.x; const vy = c.y - b.y;
      if (Math.hypot(ux, uy) < 1e-9 || Math.hypot(vx, vy) < 1e-9) { prior = undefined; continue; }
      const turn = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      if (prior !== undefined) { variation += Math.abs(Math.atan2(Math.sin(turn - prior), Math.cos(turn - prior))); pairs++; }
      prior = turn;
    }
  }
  return { length, totalTurningRadians: turning, meanCurvature: length > 0 && turns.length ? turning / length : null, turnVariationRadians: pairs ? variation / pairs : null, corners, segments: segments.length, warnings, uncertainty: 'Not quantified: reference calibration, tracking and drawing errors have no validated error bounds. Reference pixels are not physical distance.' };
}

/** Uses only adjacent accepted tracking with usable stabilization; gaps remain disconnected. */
export function observedGeometry(review: RacingLineReview): Geometry {
  const transforms = new Map(review.stabilization.transforms.map(t => [t.frame, t]));
  const values = review.tracking.observations.filter(o => o.seconds >= review.raceStartSeconds);
  const segments: Point[][] = []; let segment: Point[] = [];
  for (let i = 0; i < values.length; i++) {
    const b = values[i]; const a = values[i - 1];
    const usable = b.trackPoint && ['tracked', 'reacquired'].includes(b.quality) && transforms.get(b.frame)?.quality.usable;
    if (!usable || !b.trackPoint) { segment = []; continue; }
    if (!a || !connected(a, b) || !transforms.get(a.frame)?.quality.usable || !segment.length) { segment = []; segments.push(segment); }
    segment.push(b.trackPoint);
  }
  const gaps = values.filter(o => !o.trackPoint || !['tracked', 'reacquired'].includes(o.quality) || !transforms.get(o.frame)?.quality.usable);
  const warnings = ['Observed metrics cover accepted decoded segments after race start only; they are sampling-dependent.'];
  if (gaps.length) warnings.push(`${gaps.length} lost, suspect or stabilization-rejected observations excluded; length is partial and gaps are not filled.`);
  if (!segments.some(s => s.length > 1)) warnings.push('No connected accepted observed geometry is available.');
  return geometry(segments, warnings);
}

/** Compares every authority field so corrections and reruns invalidate comparison currency. */
export function sameAuthority(a: AlternativeAuthority, b: AlternativeAuthority): boolean {
  return a.runId === b.runId && a.correctionSetId === b.correctionSetId && a.evidenceId === b.evidenceId && a.trackReferenceId === b.trackReferenceId && a.reviewVersion === b.reviewVersion;
}
