import { describe, expect, it } from 'vitest';
import { addMarker, calibrationReadiness, emptyCalibration, markerStatus, moveMarker, replaceDetectedMarkers } from './calibration-state';

describe('calibration marker state', () => {
  it('distinguishes marker detection readiness states', () => {
    const state = { ...emptyCalibration(), raceStartSeconds: 1, carSelectionSeconds: 3, selectedCarBox: { x: 0, y: 0, width: 0.2, height: 0.2 } };
    expect(markerStatus(state)).toBe('Marker frame not selected.');
    const selected = { ...state, markerReferenceSeconds: 2 };
    expect(markerStatus(selected)).toBe('Detection not yet run.');
    expect(markerStatus({ ...selected, markerDetectionStatus: 'empty' })).toBe('Detection returned no markers.');
    expect(calibrationReadiness({ ...selected, markerDetectionStatus: 'empty' })).toContain('no green markers');
  });

  it('preserves detected source until a move changes it to manual', () => {
    const state = replaceDetectedMarkers(emptyCalibration(), [{ x: 0.2, y: 0.3 }]);
    expect(state.markers[0].source).toBe('detected');
    const moved = moveMarker(state, state.markers[0].id, { x: 0.4, y: 0.5 });
    expect(moved.markers[0]).toMatchObject({ position: { x: 0.4, y: 0.5 }, source: 'manual' });
  });

  it('adds manual markers and replaces prior markers with fresh detected markers', () => {
    const manual = addMarker(emptyCalibration(), { x: 0.1, y: 0.1 });
    const detected = replaceDetectedMarkers(manual, [{ x: 0.8, y: 0.7 }]);
    expect(detected.markers).toHaveLength(1);
    expect(detected.markers[0]).toMatchObject({ position: { x: 0.8, y: 0.7 }, source: 'detected' });
  });
});
