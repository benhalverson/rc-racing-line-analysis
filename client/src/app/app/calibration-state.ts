import type { CorrectionMarker, NormalizedBox, NormalizedPoint } from '../../../../shared/calibration-contract';

export interface CalibrationState { raceStartSeconds: number | null; markerReferenceSeconds: number | null; carSelectionSeconds: number | null; markers: CorrectionMarker[]; selectedCarBox: NormalizedBox | null; }
export const emptyCalibration = (): CalibrationState => ({ raceStartSeconds: null, markerReferenceSeconds: null, carSelectionSeconds: null, markers: [], selectedCarBox: null });
export function addMarker(state: CalibrationState, position: NormalizedPoint, source: CorrectionMarker['source'] = 'manual'): CalibrationState { return { ...state, markers: [...state.markers, { id: crypto.randomUUID(), position, source }] }; }
export function moveMarker(state: CalibrationState, id: string, position: NormalizedPoint): CalibrationState { return { ...state, markers: state.markers.map((marker) => marker.id === id ? { ...marker, position, source: 'manual' } : marker) }; }
export function removeMarker(state: CalibrationState, id: string): CalibrationState { return { ...state, markers: state.markers.filter((marker) => marker.id !== id) }; }
export function resetMarkers(state: CalibrationState): CalibrationState { return { ...state, markers: [] }; }
