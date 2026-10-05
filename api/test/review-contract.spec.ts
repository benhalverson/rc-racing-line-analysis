import { describe, expect, it } from 'vitest';
import { detectCrossings } from '../../shared/review-contract';
import type { TrackingArtifacts } from '../../shared/tracking-contract';

/** Explicit contract observations isolate gap, endpoint, and finite-gate behavior. */
function tracking(points: Array<{ x: number; y: number } | null>): TrackingArtifacts {
  return { correctionSetId: 'fixture', providerVersion: 'fixture', referenceSize: { width: 100, height: 100 }, segments: [], observations: points.map((trackPoint, frame) => ({ frame, seconds: 5 + frame * .1, trackPoint, segmentId: 'selected', quality: trackPoint ? 'tracked' : 'lost', box: null, appearanceError: null, ambiguityMargin: null, reason: 'contract fixture' })) };
}
describe('decoded crossing contract', () => {
  const gate = { a: { x: 50, y: 20 }, b: { x: 50, y: 80 } };
  it('interpolates only adjacent accepted points at source-video timestamps', () => {
    expect(detectCrossings(tracking([{ x: 40, y: 50 }, { x: 60, y: 50 }]), gate, 5)[0]).toMatchObject({ seconds: 5.05, frameBefore: 0, frameAfter: 1, source: 'detected', liveRcLapNumber: null });
  });
  it('does not cross lost regions, confirmed identity boundaries, or the extension beyond a finite gate', () => {
    expect(detectCrossings(tracking([{ x: 40, y: 50 }, null, { x: 60, y: 50 }]), gate, 0)).toEqual([]);
    const changed = tracking([{ x: 40, y: 50 }, { x: 60, y: 50 }]); changed.observations[1].segmentId = 'recovered';
    expect(detectCrossings(changed, gate, 0)).toEqual([]);
    expect(detectCrossings(tracking([{ x: 40, y: 10 }, { x: 60, y: 10 }]), gate, 0)).toEqual([]);
  });
  it('counts an exact gate sample only once and does not invent crossings from timing durations', () => {
    expect(detectCrossings(tracking([{ x: 40, y: 50 }, { x: 50, y: 50 }, { x: 60, y: 50 }]), gate, 0)).toHaveLength(1);
    expect(detectCrossings(tracking([{ x: 40, y: 50 }, { x: 50, y: 50 }, { x: 40, y: 50 }]), gate, 0)).toEqual([]);
    expect(detectCrossings(tracking([{ x: 40, y: 50 }, { x: 40, y: 50 }]), gate, 0)).toEqual([]);
  });
});
