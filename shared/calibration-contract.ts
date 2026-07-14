export type VideoStorage = "browser-sqlite" | "legacy";

export interface LocalVideoRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  lastModified: number;
}

export interface NormalizedPoint { x: number; y: number; }
export interface NormalizedBox { x: number; y: number; width: number; height: number; }

export type CorrectionSource = "detected" | "manual";

export interface CorrectionMarker {
  id: string;
  position: NormalizedPoint;
  source: CorrectionSource;
}

export interface CorrectionSetPayload {
  raceStartSeconds: number;
  markerReferenceSeconds: number;
  carSelectionSeconds: number;
  markers: CorrectionMarker[];
  selectedCarBox: NormalizedBox;
  carDescription?: string;
}

export interface CorrectionSet extends CorrectionSetPayload {
  id: string;
  analysisId: string;
  version: number;
  accepted: boolean;
  createdAt: string;
}

export function isNormalizedPoint(point: NormalizedPoint) {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

export function isNormalizedBox(box: NormalizedBox) {
  return Number.isFinite(box.x) && Number.isFinite(box.y) && Number.isFinite(box.width) && Number.isFinite(box.height)
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1 && box.y + box.height <= 1;
}
