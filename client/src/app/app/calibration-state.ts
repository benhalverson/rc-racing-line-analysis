import { isNormalizedBox, type CorrectionMarker, type NormalizedBox, type NormalizedPoint } from '../../../../shared/calibration-contract';

export type MarkerDetectionStatus = 'not-run' | 'empty' | 'found';
export interface CalibrationState { raceStartSeconds: number | null; markerReferenceSeconds: number | null; carSelectionSeconds: number | null; markers: CorrectionMarker[]; selectedCarBox: NormalizedBox | null; markerDetectionStatus: MarkerDetectionStatus; }
export const canStartCalibration = (analysisState: string) => analysisState === 'draft';
export const emptyCalibration = (): CalibrationState => ({ raceStartSeconds: null, markerReferenceSeconds: null, carSelectionSeconds: null, markers: [], selectedCarBox: null, markerDetectionStatus: 'not-run' });
export function addMarker(state: CalibrationState, position: NormalizedPoint, source: CorrectionMarker['source'] = 'manual'): CalibrationState { return { ...state, markers: [...state.markers, { id: crypto.randomUUID(), position, source }] }; }
export function moveMarker(state: CalibrationState, id: string, position: NormalizedPoint): CalibrationState { return { ...state, markers: state.markers.map((marker) => marker.id === id ? { ...marker, position, source: 'manual' } : marker) }; }
export function removeMarker(state: CalibrationState, id: string): CalibrationState { return { ...state, markers: state.markers.filter((marker) => marker.id !== id) }; }
export function resetMarkers(state: CalibrationState): CalibrationState { return { ...state, markers: [] }; }
export function replaceDetectedMarkers(state: CalibrationState, positions: NormalizedPoint[]): CalibrationState { return { ...state, markers: positions.map((position) => ({ id: crypto.randomUUID(), position, source: 'detected' })), markerDetectionStatus: positions.length ? 'found' : 'empty' }; }
export function calibrationReadiness(state: CalibrationState): string | null {
  if (state.raceStartSeconds === null) return 'Set race start on the video.';
  if (state.markerReferenceSeconds === null) return 'Choose a marker frame.';
  if (state.markerDetectionStatus === 'not-run') return 'Run green marker detection on the selected frame.';
  if (state.markerDetectionStatus === 'empty') return 'Detection found no green markers. Choose another frame or run detection again.';
  if (!state.markers.length) return 'Review the detected markers and keep at least one marker.';
  if (state.carSelectionSeconds === null || !state.selectedCarBox) return 'Choose a car frame and drag a box around the car.';
  if (!isNormalizedBox(state.selectedCarBox)) return 'Redraw the car box so it stays inside the video frame.';
  return null;
}

export function markerStatus(state: CalibrationState): string {
  if (state.markerReferenceSeconds === null) return 'Marker frame not selected.';
  if (state.markerDetectionStatus === 'not-run') return 'Detection not yet run.';
  if (state.markerDetectionStatus === 'empty') return 'Detection returned no markers.';
  return state.markers.length ? 'Markers available for review.' : 'Review the detected markers and keep at least one marker.';
}
