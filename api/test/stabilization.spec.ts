import { describe, expect, it, vi } from "vitest";
import {
  MarkerBasedStabilizationProvider,
  type MarkerObservation,
  type MarkerTransformEstimator,
} from "../src/stabilization";

const markers = (frame: number, count: number): MarkerObservation[] =>
  Array.from({ length: count }, (_, index) => ({
    frame,
    markerId: `marker-${index}`,
    imagePoint: { x: index, y: index },
    trackPoint: { x: index, y: index },
    confidence: 1,
  }));

const validCandidate = {
  matrix: [1, 0, 0, 0, 1, 0],
  reprojectionError: 1,
  inlierCount: 4,
  scale: 1,
  rotationDegrees: 0,
  cropValid: true,
};
const failingReprojectionError = 4;
const insufficientInliers = 2;

describe("MarkerBasedStabilizationProvider", () => {
  it("keeps a usable affine transform when its diagnostics pass", async () => {
    const estimator: MarkerTransformEstimator = { estimate: vi.fn(() => validCandidate) };

    const artifacts = await new MarkerBasedStabilizationProvider(markers(1, 4), estimator).stabilize();

    expect(artifacts.markerObservations).toHaveLength(4);
    expect(artifacts.transforms).toMatchObject([{ frame: 1, model: "affine", quality: { usable: true } }]);
    expect(estimator.estimate).toHaveBeenCalledTimes(1);
  });

  it("escalates to a homography when affine reprojection diagnostics fail", async () => {
    const estimator: MarkerTransformEstimator = {
      estimate: vi.fn((model) => model === "affine"
        ? { ...validCandidate, reprojectionError: failingReprojectionError }
        : validCandidate),
    };

    const artifacts = await new MarkerBasedStabilizationProvider(markers(1, 4), estimator).stabilize();

    expect(artifacts.transforms).toMatchObject([{ model: "homography", quality: { usable: true } }]);
    expect(estimator.estimate).toHaveBeenNthCalledWith(1, "affine", expect.any(Array));
    expect(estimator.estimate).toHaveBeenNthCalledWith(2, "homography", expect.any(Array));
  });

  it("marks transforms unusable when marker and crop diagnostics fail", async () => {
    const estimator: MarkerTransformEstimator = {
      estimate: vi.fn(() => ({ ...validCandidate, inlierCount: insufficientInliers, cropValid: false })),
    };

    const artifacts = await new MarkerBasedStabilizationProvider(markers(1, 2), estimator).stabilize();

    expect(artifacts.transforms).toMatchObject([{
      model: "affine",
      quality: { enoughMarkers: false, inliersValid: false, cropValid: false, usable: false },
    }]);
    expect(estimator.estimate).toHaveBeenCalledTimes(1);
  });
});
