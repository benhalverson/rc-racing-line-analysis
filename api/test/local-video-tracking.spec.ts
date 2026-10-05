import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { LocalVideoTrackingProvider, type TrackingOptions } from '../src/local-video-tracking';
import type { VideoFrame, VideoFrameSource } from '../src/local-video-stabilization';

/** Draws a selected textured car and optional lookalike into deterministic decoded pixels. */
function frame(index: number, x: number | null, brightness = 0, competitor = false): VideoFrame {
  const rgb = new Uint8Array(80 * 60 * 3); rgb.fill(12);
  /** Paints the same car appearance at a known fixture position. */
  const paint = (left: number) => {
    for (let y = 20; y < 28; y++) for (let px = left; px < left + 8; px++) {
      const offset = (y * 80 + px) * 3;
      rgb[offset] = 180 + brightness; rgb[offset + 1] = ((px - left + y) % 2 ? 40 : 90) + brightness; rgb[offset + 2] = 60 + brightness;
    }
  };
  if (x !== null) paint(x); if (competitor) paint(30);
  return { frame: index, seconds: index / 10, width: 80, height: 60, totalFrames: 4, rgb };
}
/** Supplies a repeatable decoded-frame test port. */
function source(frames: VideoFrame[]): VideoFrameSource { return { async *frames() { yield* frames; } }; }
/** Builds accepted calibration and explicit per-frame stabilization quality. */
function options(count: number): TrackingOptions {
  return { videoPath: '/fixture', recoveries: [], correction: { id: 'correction', analysisId: 'analysis', version: 1, accepted: true, createdAt: '', raceStartSeconds: 0, markerReferenceSeconds: 0, carSelectionSeconds: 0, markers: [], selectedCarBox: { x: 20 / 80, y: 20 / 60, width: 8 / 80, height: 8 / 60 } }, stabilization: { referenceSize: { width: 80, height: 60 }, markerObservations: [], transforms: Array.from({ length: count }, (_, frame) => ({ frame, seconds: frame / 10, model: 'affine', matrix: [1, 0, -2, 0, 1, 0], quality: { enoughMarkers: true, reprojectionValid: true, inliersValid: true, scaleValid: true, rotationValid: true, cropValid: true, usable: true } })) } };
}

describe('selected car tracking from decoded pixels', () => {
  it('tracks displacement, keeps lost intervals, withholds re-ID, and resumes only after manual confirmation', async () => {
    const frames = [frame(0, 20), frame(1, 22), frame(2, null), frame(3, 26), frame(4, 28)];
    const input = options(frames.length);
    const output = await new LocalVideoTrackingProvider(input, source(frames)).track();
    expect(output.observations.map(item => item.quality)).toEqual(['tracked', 'tracked', 'lost', 'lost', 'lost']);
    expect(output.observations[1].box?.x).toBe(22); expect(output.observations[1].trackPoint?.x).toBe(24);
    const recovered = await new LocalVideoTrackingProvider({ ...input, recoveries: [{ id: 'manual-1', analysisId: 'analysis', correctionSetId: 'correction', createdAt: '', frame: 3, seconds: .3, box: { x: 26 / 80, y: 20 / 60, width: .1, height: 8 / 60 } }] }, source(frames)).track();
    expect(recovered.observations.map(item => item.quality)).toEqual(['tracked', 'tracked', 'lost', 'reacquired', 'tracked']);
    expect(recovered.observations[2]).toMatchObject({ box: null, trackPoint: null });
    expect(recovered.segments).toHaveLength(2);
    expect(await new LocalVideoTrackingProvider(input, source(frames)).track()).toEqual(output);
  });
  it('reports suspect appearance, rejects ambiguous identities, and gates unusable transforms', async () => {
    const input = options(3); input.stabilization.transforms[1].quality = { enoughMarkers: false, reprojectionValid: true, inliersValid: true, scaleValid: true, rotationValid: true, cropValid: true, usable: false };
    const output = await new LocalVideoTrackingProvider(input, source([frame(0, 20), frame(1, 22, 30), frame(2, 22, 0, true)])).track();
    expect(output.observations[1]).toMatchObject({ quality: 'suspect', trackPoint: null });
    expect(output.observations[2]).toMatchObject({ quality: 'lost', box: null, trackPoint: null });
  });
  it('withholds a lone lookalike after target disappearance instead of switching identity', async () => {
    const output = await new LocalVideoTrackingProvider(options(2), source([frame(0, 20), frame(1, null, 0, true)])).track();
    expect(output.observations[1]).toMatchObject({ quality: 'lost', box: null, trackPoint: null });
  });
  it('uses the nearest selection frame and rasterizes tiny edge boxes safely', async () => {
    const input = options(3); input.correction.carSelectionSeconds = .04;
    const output = await new LocalVideoTrackingProvider(input, source([frame(0, 20), frame(1, 22), frame(2, 24)])).track();
    expect(output.segments[0].startFrame).toBe(0);
    input.correction.selectedCarBox = { x: .999, y: .999, width: .001, height: .001 };
    const edge = await new LocalVideoTrackingProvider(input, source([frame(0, 20), frame(1, 22), frame(2, 24)])).track();
    expect(edge.segments[0].box).toEqual({ x: 79, y: 59, width: 1, height: 1 });
  });
  it('uses selection seconds and never invents a preselection observation', async () => {
    const input = options(3); input.correction.carSelectionSeconds = .1;
    const output = await new LocalVideoTrackingProvider(input, source([frame(0, 20), frame(1, 20), frame(2, 22)])).track();
    expect(output.observations[0]).toMatchObject({ quality: 'lost', box: null, segmentId: null });
    expect(output.segments[0].startFrame).toBe(1);
  });
  it('processes actual ffmpeg-decoded lossless local video, not supplied observations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'car-video-'));
    try {
      const raw = join(root, 'frames.rgb'); const video = join(root, 'race.mkv');
      await writeFile(raw, Buffer.concat([frame(0, 20), frame(1, 22), frame(2, null), frame(3, 26)].map(item => Buffer.from(item.rgb))));
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '80x60', '-framerate', '10', '-i', raw, '-c:v', 'ffv1', video]);
      const output = await new LocalVideoTrackingProvider({ ...options(4), videoPath: video }).track();
      expect(output.observations.map(item => item.quality)).toEqual(['tracked', 'tracked', 'lost', 'lost']);
      expect(output.observations.map(item => item.seconds)).toEqual([0, .1, .2, .3]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
