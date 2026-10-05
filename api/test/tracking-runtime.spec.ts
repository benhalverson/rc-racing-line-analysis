import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LocalPersistence } from '../src/local-persistence';
import { LocalArtifactStore } from '../src/local-artifacts';
import { LocalVideoStore } from '../src/local-video-store';
import { AnalysisWorkflow } from '../src/workflow';
import { createLocalApp } from '../src/local-runtime';
import { executeLocalStabilization } from '../src/processing-local';
import { LocalVideoTrackingProvider } from '../src/local-video-tracking';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
/** Creates actual encoded footage with marker geometry, selected car motion, and a retained loss. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tracking-runtime-'));
  const persistence = new LocalPersistence(join(root, 'metadata.sqlite'), resolve('api/drizzle/local-migrations'));
  const artifacts = new LocalArtifactStore(join(root, 'artifacts'), persistence); const videos = new LocalVideoStore(join(root, 'videos')); const workflow = new AnalysisWorkflow(persistence);
  cleanups.push(async () => { persistence.close(); await rm(root, { recursive: true, force: true }); });
  const markers = [{ id: 'a', position: { x: .15, y: .15 }, source: 'manual' as const }, { id: 'b', position: { x: .85, y: .15 }, source: 'manual' as const }, { id: 'c', position: { x: .85, y: .85 }, source: 'manual' as const }];
  const frames = Array.from({ length: 40 }, (_, frame) => {
    const rgb = Buffer.alloc(100 * 100 * 3, 12);
    for (const marker of markers) for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) rgb[((marker.position.y * 100 + y) * 100 + marker.position.x * 100 + x) * 3 + 1] = 255;
    const left = frame === 0 ? 40 : frame === 1 ? 42 : 46;
    if (frame !== 2) for (let y = 50; y < 58; y++) for (let x = left; x < left + 8; x++) { const i = (y * 100 + x) * 3; rgb[i] = 180; rgb[i + 1] = (x - left + y) % 2 ? 40 : 90; rgb[i + 2] = 60; }
    return rgb;
  });
  const raw = join(root, 'frames.rgb'); const video = join(root, 'race.mkv'); await writeFile(raw, Buffer.concat(frames));
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '100x100', '-framerate', '10', '-i', raw, '-c:v', 'ffv1', video]);
  const imported = await videos.importVideo(new File([await readFile(video)], 'race.mkv'));
  const analysis = await workflow.createDraft({ ...imported, videoName: 'race.mkv', videoStorage: 'local-disk' }); await workflow.startCalibration(analysis.id);
  const correction = await workflow.createAndAcceptCorrectionSet(analysis.id, { markers, raceStartSeconds: 0, markerReferenceSeconds: 0, carSelectionSeconds: 0, selectedCarBox: { x: .4, y: .5, width: .08, height: .08 } });
  return { persistence, artifacts, videos, workflow, analysis, correction };
}

/** Performs a JSON request against the real local runtime adapter. */
function post(app: ReturnType<typeof createLocalApp>, id: string, action: string, body?: unknown) {
  return app.request(`http://localhost/analyses/${id}/${action}`, { method: 'POST', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
}

describe('real decoded tracking through local runtime', () => {
  it('cancels during tracking, replays on resume, manually confirms identity, and repeats under the same accepted calibration', async () => {
    const ctx = await fixture(); let stopOnce = true;
    let reached!: () => void; const checkpointReached = new Promise<void>(resolve => { reached = resolve; });
    const app = createLocalApp(ctx.workflow, ctx.persistence, ctx.artifacts, ctx.videos, (id, signal) => executeLocalStabilization(id, ctx.workflow, ctx.persistence, ctx.artifacts, {
      signal, resolveVideoPath: async reference => ctx.videos.resolvePath(reference),
      trackingProviderFactory: options => new LocalVideoTrackingProvider({ ...options, onFrame: async output => {
        await options.onFrame?.(output);
        if (stopOnce) { stopOnce = false; reached(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); signal.throwIfAborted(); }
      } }),
    }));
    expect((await post(app, ctx.analysis.id, 'queue')).status).toBe(200); expect((await post(app, ctx.analysis.id, 'start')).status).toBe(200);
    await checkpointReached;
    expect(await ctx.workflow.get(ctx.analysis.id)).toMatchObject({ phase: 'tracking', checkpoint: 'tracking-frame-29' });
    expect((await post(app, ctx.analysis.id, 'cancel')).status).toBe(200);
    const firstRun = await ctx.persistence.getRun(ctx.analysis.id); expect(firstRun).toMatchObject({ status: 'cancelled', trackingFrame: 29, frame: 39 });
    expect((await post(app, ctx.analysis.id, 'resume')).status).toBe(200);
    await expect.poll(async () => (await ctx.workflow.get(ctx.analysis.id)).state, { timeout: 10_000 }).toBe('needs_correction');
    const lost = await ctx.artifacts.readPublishedTracking(ctx.analysis.id); expect(lost?.observations[2]).toMatchObject({ quality: 'lost', box: null });
    expect((await app.request(`http://localhost/analyses/${ctx.analysis.id}/tracking/observations`, { method: 'POST' })).status).toBe(404);
    expect((await post(app, ctx.analysis.id, 'tracking/rebox', { frame: 3, box: { x: .46, y: .5, width: .08, height: .08 }, observationFilePath: '/arbitrary' })).status).toBe(400);
    expect((await post(app, ctx.analysis.id, 'tracking/rebox', { frame: 3, box: { x: .46, y: .5, width: .08, height: .08 } })).status).toBe(201);
    expect((await post(app, ctx.analysis.id, 'resume')).status).toBe(200);
    await expect.poll(async () => (await ctx.workflow.get(ctx.analysis.id)).state, { timeout: 10_000 }).toBe('completed');
    const recovered = await ctx.artifacts.readPublishedTracking(ctx.analysis.id); expect(recovered?.observations[2].quality).toBe('lost'); expect(recovered?.observations[3].quality).toBe('reacquired'); expect(recovered?.segments).toHaveLength(2);
    expect((await ctx.persistence.getRun(ctx.analysis.id))?.id).toBe(firstRun?.id);
    expect((await ctx.persistence.listArtifacts(ctx.analysis.id))).toHaveLength(4);
    expect((await post(app, ctx.analysis.id, 'queue')).status).toBe(200); expect((await post(app, ctx.analysis.id, 'start')).status).toBe(200);
    await expect.poll(async () => (await ctx.workflow.get(ctx.analysis.id)).state, { timeout: 10_000 }).toBe('completed');
    expect((await ctx.persistence.getRun(ctx.analysis.id))?.id).not.toBe(firstRun?.id);
    expect(await ctx.artifacts.readPublishedTracking(ctx.analysis.id)).toEqual(recovered);
    await ctx.workflow.startCalibration(ctx.analysis.id);
    await ctx.workflow.createAndAcceptCorrectionSet(ctx.analysis.id, { ...ctx.correction, selectedCarBox: { x: .42, y: .5, width: .08, height: .08 } });
    expect(await ctx.artifacts.readPublishedTracking(ctx.analysis.id)).toBeUndefined();
  }, 20_000);
  it('restarts after an immediate terminal-state resume while the predecessor is still finishing', async () => {
    const ctx = await fixture(); let calls = 0; let release!: () => void;
    const app = createLocalApp(ctx.workflow, ctx.persistence, ctx.artifacts, ctx.videos, async id => {
      calls++;
      if (calls === 1) { await ctx.workflow.needsCorrection(id, 'fixture loss'); await new Promise<void>(resolve => { release = resolve; }); }
      else await ctx.workflow.complete(id);
    });
    await post(app, ctx.analysis.id, 'queue'); await post(app, ctx.analysis.id, 'start');
    await expect.poll(async () => (await ctx.workflow.get(ctx.analysis.id)).state, { timeout: 10_000 }).toBe('needs_correction');
    const resumed = post(app, ctx.analysis.id, 'resume');
    release(); expect((await resumed).status).toBe(200);
    await expect.poll(async () => (await ctx.workflow.get(ctx.analysis.id)).state, { timeout: 10_000 }).toBe('completed'); expect(calls).toBe(2);
  });
});
