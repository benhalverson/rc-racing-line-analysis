import { describe, expect, it } from 'vitest';
import { MarkerBasedStabilizationProvider, transformUsablePoint, type MarkerObservation } from '../src/stabilization';
import { NumericalMarkerTransformEstimator, projectPoint } from '../src/numerical-stabilization';

const positions = [{ x: 20, y: 20 }, { x: 180, y: 20 }, { x: 180, y: 180 }, { x: 20, y: 180 }, { x: 100, y: 60 }, { x: 70, y: 130 }];
/** Produces known correspondences from a forward reference-to-image warp. */
function observations(matrix: number[]): MarkerObservation[] { return positions.map((point, index) => ({ frame: 0, markerId: String(index), trackPoint: point, imagePoint: projectPoint(matrix, point), confidence: 1 })); }

describe('production numerical stabilization', () => {
  it('recovers affine ground truth and rejects one outlier by consensus', async () => {
    const data = observations([1, 0, 8, 0, 1, -5]); data[5].imagePoint = { x: 500, y: 500 };
    const artifacts = await new MarkerBasedStabilizationProvider(data, new NumericalMarkerTransformEstimator(200, 200)).stabilize();
    const transform = artifacts.transforms[0];
    expect(transform.quality.usable).toBe(true); expect(transform.model).toBe('affine');
    expect(transform.diagnostics?.inlierCount).toBe(5);
    const mapped = transformUsablePoint(transform, { x: 58, y: 45 });
    expect(mapped?.x).toBeCloseTo(50, 6); expect(mapped?.y).toBeCloseTo(50, 6);
  });
  it('automatically escalates a perspective mismatch supported by six markers', async () => {
    const warp = [1, 0, 0, 0, 1, 0, 0.00012, 0.00008, 1];
    const data = observations([1, 0, 0, 0, 1, 0]).map(observation => { const trackPoint = { x: observation.trackPoint.x * 5, y: observation.trackPoint.y * 5 }; return { ...observation, trackPoint, imagePoint: projectPoint(warp, trackPoint) }; });
    const { transforms } = await new MarkerBasedStabilizationProvider(data, new NumericalMarkerTransformEstimator(1000, 1000)).stabilize();
    expect(transforms[0]).toMatchObject({ model: 'homography', quality: { usable: true } });
    const image = projectPoint(warp, { x: 80, y: 90 });
    expect(transformUsablePoint(transforms[0], image)?.x).toBeCloseTo(80, 6);
  });
  it('gates degeneracy, missing frames, nonfinite inputs and bad crop', async () => {
    for (const data of [observations([1, 0, 1000, 0, 1, 0]), observations([0, 0, 0, 0, 0, 0]), observations([1, 0, 0, 0, 1, 0]).map(observation => ({ ...observation, imagePoint: { x: NaN, y: 1 } }))]) {
      const { transforms } = await new MarkerBasedStabilizationProvider(data, new NumericalMarkerTransformEstimator(200, 200), undefined, [0, 1]).stabilize();
      expect(transforms.every(transform => !transform.quality.usable)).toBe(true);
      expect(transformUsablePoint(transforms[0], { x: 5, y: 6 })).toBeNull();
    }
  });
  it('gates excessive scale, rotation and duplicate identities', async () => {
    for (const matrix of [[3, 0, 0, 0, 3, 0], [0, -1, 200, 1, 0, 0]]) {
      const { transforms } = await new MarkerBasedStabilizationProvider(observations(matrix), new NumericalMarkerTransformEstimator(200, 200)).stabilize();
      expect(transforms[0].quality.usable).toBe(false);
    }
    const data = observations([1, 0, 0, 0, 1, 0]).map(point => ({ ...point, markerId: 'duplicate' }));
    const { transforms } = await new MarkerBasedStabilizationProvider(data, new NumericalMarkerTransformEstimator(200, 200)).stabilize();
    expect(transforms[0].quality.enoughMarkers).toBe(false);
  });
  it('orders observed frames and rejects invalid frame indices', async () => {
    const data = observations([1, 0, 0, 0, 1, 0]);
    const { transforms } = await new MarkerBasedStabilizationProvider([...data.map(point => ({ ...point, frame: 2 })), ...data], new NumericalMarkerTransformEstimator(200, 200)).stabilize();
    expect(transforms.map(transform => transform.frame)).toEqual([0, 2]);
    await expect(new MarkerBasedStabilizationProvider([{ ...data[0], frame: -1 }], new NumericalMarkerTransformEstimator(200, 200)).stabilize()).rejects.toThrow('Invalid marker frame');
  });
});
