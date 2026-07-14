import { isNormalizedBox, type CorrectionMarker, type NormalizedBox, type NormalizedPoint } from '../../../../shared/calibration-contract';

export interface CalibrationState { raceStartSeconds: number | null; markerReferenceSeconds: number | null; carSelectionSeconds: number | null; markers: CorrectionMarker[]; selectedCarBox: NormalizedBox | null; }
export const canStartCalibration = (analysisState: string) => analysisState === 'draft';
export const emptyCalibration = (): CalibrationState => ({ raceStartSeconds: null, markerReferenceSeconds: null, carSelectionSeconds: null, markers: [], selectedCarBox: null });
export function addMarker(state: CalibrationState, position: NormalizedPoint, source: CorrectionMarker['source'] = 'manual'): CalibrationState { return { ...state, markers: [...state.markers, { id: crypto.randomUUID(), position, source }] }; }
export function moveMarker(state: CalibrationState, id: string, position: NormalizedPoint): CalibrationState { return { ...state, markers: state.markers.map((marker) => marker.id === id ? { ...marker, position, source: 'manual' } : marker) }; }
export function removeMarker(state: CalibrationState, id: string): CalibrationState { return { ...state, markers: state.markers.filter((marker) => marker.id !== id) }; }
export function resetMarkers(state: CalibrationState): CalibrationState { return { ...state, markers: [] }; }
export function calibrationReadiness(state: CalibrationState): string | null {
  if (state.raceStartSeconds === null) return 'Set race start on the video.';
  if (state.markerReferenceSeconds === null || !state.markers.length) return 'Choose a marker frame and place at least one marker.';
  if (state.carSelectionSeconds === null || !state.selectedCarBox) return 'Choose a car frame and drag a box around the car.';
  if (!isNormalizedBox(state.selectedCarBox)) return 'Redraw the car box so it stays inside the video frame.';
  return null;
}
