export interface TrackPoint {
  x: number;
  y: number;
}

export interface LineComparison {
  length: number;
  corner: { entry: number; apex: number; exit: number } | undefined;
  curvature: number;
  smoothness: number;
  uncertainty: number;
}

export interface AlternativeLine {
  analysisId: string;
  correctionSetId: string;
  trackReferenceId: string;
  name: string;
  versions: { version: number; points: TrackPoint[]; comparison: LineComparison }[];
}

export function compareLine(points: TrackPoint[]): LineComparison {
  const lengths = points.slice(1).map((point, index) => distance(points[index], point));
  const length = lengths.reduce((total, value) => total + value, 0);
  const turns = points.slice(1, -1).map((point, index) => turn(points[index], point, points[index + 2]));
  const curvature = turns.reduce((total, value, index) => total + Math.abs(value) / (lengths[index] + lengths[index + 1]), 0);
  const smoothness = turns.length < 2 ? 0 : turns.slice(1).reduce((total, value, index) => total + Math.abs(value - turns[index]), 0) / (turns.length - 1);
  const apex = turns.reduce((best, value, index) => Math.abs(value) > Math.abs(turns[best] ?? 0) ? index : best, 0) + 1;
  return {
    length,
    corner: points.length < 3 ? undefined : { entry: percent(apex - 1, points.length), apex: percent(apex, points.length), exit: percent(apex + 1, points.length) },
    curvature,
    smoothness,
    uncertainty: length * (0.02 + 1 / Math.max(points.length, 2) / 10),
  };
}

export function reviseAlternative(lines: AlternativeLine[], analysisId: string, name: string, points: TrackPoint[]): AlternativeLine[] {
  const comparison = compareLine(points);
  const index = lines.findIndex((line) => line.analysisId === analysisId && line.name === name);
  if (index < 0) return [...lines, { analysisId, correctionSetId: 'accepted', trackReferenceId: 'stabilized-track', name, versions: [{ version: 1, points, comparison }] }];
  const line = lines[index];
  const revised = { ...line, versions: [...line.versions, { version: line.versions.length + 1, points, comparison }] };
  return [...lines.slice(0, index), revised, ...lines.slice(index + 1)];
}

function distance(a: TrackPoint, b: TrackPoint) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function turn(a: TrackPoint, b: TrackPoint, c: TrackPoint) {
  return Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
}

function percent(index: number, count: number) {
  return Math.round(Math.max(0, Math.min(1, index / (count - 1))) * 100);
}
