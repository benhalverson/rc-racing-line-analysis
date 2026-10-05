import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { LocalVideoStabilizationProvider, type VideoFrame, type VideoFrameSource } from '../src/local-video-stabilization';

const markers = [{ id: 'a', position: { x: 0.2, y: 0.2 } }, { id: 'b', position: { x: 0.8, y: 0.2 } }, { id: 'c', position: { x: 0.8, y: 0.8 } }, { id: 'd', position: { x: 0.2, y: 0.8 } }];
/** Creates a synthetic green-marker frame with known translation. */
function frame(index: number, shift = 0, visible = true): VideoFrame {
  const rgb = new Uint8Array(100 * 100 * 3);
  if (visible) for (const marker of markers) for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) rgb[((marker.position.y * 100 + y) * 100 + marker.position.x * 100 + shift + x) * 3 + 1] = 255;
  return { frame: index, seconds: index / 10, width: 100, height: 100, rgb };
}
/** Provides repeatable isolated frames through the public decoder contract. */
function source(frames: VideoFrame[]): VideoFrameSource { return { async *frames() { yield* frames; } }; }
const options = { videoPath: '/synthetic', markers, markerReferenceSeconds: 0, raceStartSeconds: 0 };

describe('local video stabilization provider', () => {
  it('preserves accepted identities, gates marker loss and resumes by replaying identity history', async () => {
    const frames = [frame(0), frame(1, 3), frame(2, 0, false), frame(3, 4)];
    const artifacts = await new LocalVideoStabilizationProvider(options, source(frames)).stabilize();
    expect(artifacts.transforms.map(transform => transform.quality.usable)).toEqual([true, true, false, true]);
    expect(artifacts.markerObservations.filter(point => point.frame === 1).map(point => point.markerId)).toEqual(['a', 'b', 'c', 'd']);
    expect(artifacts.transforms[1].matrix[2]).toBeCloseTo(-3);
    const resumed = await new LocalVideoStabilizationProvider({ ...options, startFrame: 3 }, source(frames)).stabilize();
    expect(resumed.transforms).toEqual(artifacts.transforms.slice(3));
  });
  it('rejects missing frame ordering and cancellation', async () => {
    await expect(new LocalVideoStabilizationProvider(options, source([frame(0), frame(2)])).stabilize()).rejects.toThrow('Missing, unordered');
    const controller = new AbortController(); controller.abort();
    await expect(new LocalVideoStabilizationProvider({ ...options, signal: controller.signal }, source([frame(0)])).stabilize()).rejects.toThrow();
  });
  it('decodes a real isolated local synthetic video with production ffmpeg', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marker-video-'));
    try {
      const raw = join(directory, 'frames.rgb'); const video = join(directory, 'test.mkv');
      await writeFile(raw, Buffer.concat([Buffer.from(frame(0).rgb), Buffer.from(frame(1, 3).rgb)]));
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '100x100', '-framerate', '10', '-i', raw, '-c:v', 'ffv1', video]);
      const artifacts = await new LocalVideoStabilizationProvider({ ...options, videoPath: video }).stabilize();
      expect(artifacts.transforms).toHaveLength(2); expect(artifacts.transforms.every(transform => transform.quality.usable)).toBe(true);
      expect(artifacts.transforms[1].matrix[2]).toBeCloseTo(-3);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
