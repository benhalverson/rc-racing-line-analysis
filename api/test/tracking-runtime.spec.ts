import { eq } from 'drizzle-orm';
import { analyses, correctionSets } from '../src/db/schema';
import type { AlternativeWorkspace } from '../../shared/alternative-contract';
import { alternativeRevisions } from '../src/db/schema';
import type { RacingLineReview } from '../../shared/review-contract';
import { LocalTimingStore } from '../src/local-timing-store';
import { reviewRevisions } from '../src/db/schema';
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
  return { root, persistence, artifacts, videos, workflow, analysis, correction };
}

/** Performs a JSON request against the real local runtime adapter. */
async function post(app: ReturnType<typeof createLocalApp>, id: string, action: string, body?: unknown) {
  if (action === 'review' && body && typeof body === 'object') { const current = await (await app.request(`http://localhost/analyses/${id}/review`)).json() as RacingLineReview; body = { evidenceId: current.revision.evidenceId, ...body }; }
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
    const reviewUrl = `http://localhost/analyses/${ctx.analysis.id}/review`;
    const empty = await (await app.request(reviewUrl)).json() as RacingLineReview; expect(empty.laps).toEqual([]);
    const gate = await (await post(app, ctx.analysis.id, 'review', { version: 0, runId: firstRun?.id, action: 'gate', line: { a: { x: 45, y: 40 }, b: { x: 45, y: 70 } } })).json() as RacingLineReview;
    expect(gate.laps).toHaveLength(1); expect(gate.laps[0].crossing.seconds).toBeCloseTo(.05); expect(gate.laps[0].liveRcLap).toBeNull();
    expect((await post(app, ctx.analysis.id, 'review', { version: 0, runId: firstRun?.id, action: 'add', seconds: .25 })).status).toBe(400);
    const added = await (await post(app, ctx.analysis.id, 'review', { version: gate.revision.version, runId: firstRun?.id, action: 'add', seconds: .25 })).json() as RacingLineReview;
    expect(added.laps[1].evidenceQuality).toBe('invalid');
    const range = await app.request(`http://localhost/analyses/${ctx.analysis.id}/video`, { headers: { range: 'bytes=0-9' } }); expect(range.status).toBe(206); expect((await range.arrayBuffer()).byteLength).toBe(10);
    const timing = { id: 'saved-timing', source: 'liverc' as const, trackHost: 'fixture.liverc.com', trackName: 'Fixture', trackUrl: 'https://fixture.liverc.com/', eventName: 'Fixture', eventUrl: 'https://fixture.liverc.com/event', raceId: '1', raceLabel: 'Main', roundLabel: '', classLabel: 'Buggy', raceUrl: 'https://fixture.liverc.com/race', driverName: 'Fixture driver', normalizedDriverName: 'fixture driver', driverId: null, fetchedAt: '2026-07-14T00:00:00.000Z', parserVersion: 'fixture-parser', sourceHash: 'fixture-hash', laps: [{ lapNumber: 7, lapTimeSeconds: 19.5, lapTimeText: '19.500', valid: true, statusText: null }] };
    await new LocalTimingStore(ctx.persistence.db).saveTimingImport(timing);
    const bound = await (await post(app, ctx.analysis.id, 'review', { version: added.revision.version, runId: firstRun?.id, action: 'timing', timingImportId: timing.id })).json() as RacingLineReview;
    const aligned = await (await post(app, ctx.analysis.id, 'review', { version: bound.revision.version, runId: firstRun?.id, action: 'assign', id: gate.laps[0].crossing.id, lapNumber: 7 })).json() as RacingLineReview;
    expect(aligned.laps[0]).toMatchObject({ videoEndSeconds: .05, liveRcLap: { lapNumber: 7, lapTimeSeconds: 19.5 }, evidenceQuality: 'uncertain' });
    expect(aligned.timing?.sourceHash).toBe('fixture-hash');
    expect((await post(app, ctx.analysis.id, 'review', { version: aligned.revision.version, runId: firstRun?.id, action: 'assign', id: added.laps[1].crossing.id, lapNumber: 7 })).status).toBe(400);
    const corrected = await (await post(app, ctx.analysis.id, 'review', { version: aligned.revision.version, runId: firstRun?.id, action: 'correct', id: gate.laps[0].crossing.id, seconds: .06 })).json() as RacingLineReview;
    expect(corrected.laps[0].crossing).toMatchObject({ source: 'manual', frameBefore: null, frameAfter: null });
    expect(ctx.persistence.db.select().from(reviewRevisions).all()).toHaveLength(5);
    expect((await (await app.request(reviewUrl)).json() as RacingLineReview).revision).toEqual(corrected.revision);

    expect((await app.request(`http://localhost/analyses/${ctx.analysis.id}/tracking/observations`, { method: 'POST' })).status).toBe(404);
    expect((await post(app, ctx.analysis.id, 'tracking/rebox', { frame: 3, box: { x: .46, y: .5, width: .08, height: .08 }, observationFilePath: '/arbitrary' })).status).toBe(400);
    expect((await post(app, ctx.analysis.id, 'tracking/rebox', { frame: 3, box: { x: .46, y: .5, width: .08, height: .08 } })).status).toBe(201);
    expect((await post(app, ctx.analysis.id, 'resume')).status).toBe(200);
    await expect.poll(async () => (await ctx.workflow.get(ctx.analysis.id)).state, { timeout: 10_000 }).toBe('completed');
    const recovered = await ctx.artifacts.readPublishedTracking(ctx.analysis.id); expect(recovered?.observations[2].quality).toBe('lost'); expect(recovered?.observations[3].quality).toBe('reacquired'); expect(recovered?.segments).toHaveLength(2);
    expect((await ctx.persistence.getRun(ctx.analysis.id))?.id).toBe(firstRun?.id);
    const refreshed = await (await app.request(`http://localhost/analyses/${ctx.analysis.id}/review`)).json() as RacingLineReview;
    expect(refreshed.laps).toEqual([]); expect(refreshed.revision.evidenceId).not.toBe(empty.revision.evidenceId);
    expect((await ctx.persistence.listArtifacts(ctx.analysis.id))).toHaveLength(4);
    expect((await post(app, ctx.analysis.id, 'queue')).status).toBe(200); expect((await post(app, ctx.analysis.id, 'start')).status).toBe(200);
    await expect.poll(async () => (await ctx.workflow.get(ctx.analysis.id)).state, { timeout: 10_000 }).toBe('completed');
    expect((await ctx.persistence.getRun(ctx.analysis.id))?.id).not.toBe(firstRun?.id);
    expect((await (await app.request(`http://localhost/analyses/${ctx.analysis.id}/review`)).json() as RacingLineReview).revision.version).toBe(0);
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

/** Exercises durable alternatives against the actual decoded tracking and review workflow. */
it('persists immutable hypotheses, rejects stale authority and concurrent revisions, and preserves loss', async () => {
  const ctx = await fixture();
  await ctx.workflow.queue(ctx.analysis.id); await ctx.workflow.start(ctx.analysis.id);
  await executeLocalStabilization(ctx.analysis.id, ctx.workflow, ctx.persistence, ctx.artifacts, { resolveVideoPath: async reference => ctx.videos.resolvePath(reference) });
  const app = createLocalApp(ctx.workflow, ctx.persistence, ctx.artifacts, ctx.videos, async () => undefined);
  const url = `http://localhost/analyses/${ctx.analysis.id}/alternatives`;
  const workspace = await (await app.request(url)).json() as AlternativeWorkspace;
  expect(workspace.observed.length).toBeCloseTo(2);
  expect(workspace.observed.warnings.join(' ')).toContain('gaps are not filled');
  const input = { ...workspace.authority, alternativeId: null, baseVersion: 0, name: 'Late apex', points: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }] };
  const first = await (await post(app, ctx.analysis.id, 'alternatives', input)).json() as AlternativeWorkspace;
  expect(first.versions[0]).toMatchObject({ name: 'Late apex', version: 1, hypothetical: true, geometry: { length: 40, uncertainty: expect.stringContaining('Not quantified') } });
  expect(first.versions[0]).not.toHaveProperty('lapTime');
  const revision = { ...input, alternativeId: first.versions[0].alternativeId, baseVersion: 1, name: 'Later apex', points: [{ x: 10, y: 10 }, { x: 40, y: 40 }] };
  const results = await Promise.all([post(app, ctx.analysis.id, 'alternatives', revision), post(app, ctx.analysis.id, 'alternatives', revision)]);
  expect(results.map(r => r.status).sort()).toEqual([201, 400]);
  const reopened = await (await app.request(url)).json() as AlternativeWorkspace;
  expect(reopened.versions.map(v => [v.name, v.version])).toEqual([['Late apex', 1], ['Later apex', 2]]);
  expect(reopened.versions[0].points).toEqual(input.points);
  const rows = ctx.persistence.db.select().from(alternativeRevisions).all();
  expect(rows).toHaveLength(2); expect(rows[0]).not.toHaveProperty('points');
  const disk = JSON.parse(await readFile(rows[0].path, 'utf8'));
  expect(disk.geometry).toEqual(first.versions[0].geometry); expect(disk.geometryVersion).toBe(first.versions[0].geometryVersion);
  const independent = new LocalPersistence(join(ctx.root, 'metadata.sqlite'), resolve('api/drizzle/local-migrations'));
  try {
    const independentApp = createLocalApp(new AnalysisWorkflow(independent), independent, new LocalArtifactStore(ctx.artifacts.root, independent), ctx.videos, async () => undefined);
    expect(await (await independentApp.request(url)).json()).toEqual(reopened);
  } finally { independent.close(); }
  for (const invalid of [{ name: ' ' }, { points: [{ x: -1, y: 1 }, { x: 1, y: 1 }] }, { points: [{ x: 1, y: 1 }, { x: 1, y: 1 }] }, { lapTime: 10 }, { baseVersion: -1 }]) expect((await post(app, ctx.analysis.id, 'alternatives', { ...input, ...invalid })).status).toBe(400);
  const review = await (await app.request(`http://localhost/analyses/${ctx.analysis.id}/review`)).json() as RacingLineReview;
  expect((await post(app, ctx.analysis.id, 'review', { ...review.revision, action: 'add', seconds: .25 })).status).toBe(400); // strict transport rejects extra revision fields
  expect((await post(app, ctx.analysis.id, 'review', { version: review.revision.version, runId: review.revision.runId, action: 'add', seconds: .25 })).status).toBe(201);
  expect((await post(app, ctx.analysis.id, 'alternatives', input)).status).toBe(400);
  const stale = await (await app.request(url)).json() as AlternativeWorkspace;
  expect(stale.versions.every(v => !v.current)).toBe(true);
  expect(stale.versions[0].points).toEqual(input.points);
});

/** Checks local workspace reopening and optimistic immutable-version selection through HTTP workflow ports. */
it('reopens saved metadata and reruns a prior correction without rewriting history or allowing stale selection', async () => {
  const ctx = await fixture();
  const app = createLocalApp(ctx.workflow, ctx.persistence, ctx.artifacts, ctx.videos, (id, signal) => executeLocalStabilization(id, ctx.workflow, ctx.persistence, ctx.artifacts, { signal, resolveVideoPath: async reference => ctx.videos.resolvePath(reference) }));
  const list = await (await app.request('http://localhost/analyses')).json() as { analyses: Array<{ id: string; videoPath: string }> };
  expect(list.analyses[0]).toMatchObject({ id: ctx.analysis.id, videoPath: ctx.analysis.videoPath });
  await post(app, ctx.analysis.id, 'queue'); await post(app, ctx.analysis.id, 'start');
  await expect.poll(async () => (await ctx.workflow.get(ctx.analysis.id)).state).toBe('needs_correction');
  await post(app, ctx.analysis.id, 'calibration/start');
  const payload = { raceStartSeconds: 0, markerReferenceSeconds: 0, carSelectionSeconds: 0, selectedCarBox: ctx.correction.selectedCarBox, markers: ctx.correction.markers.map((m, i) => i === 0 ? { ...m, source: 'manual', position: { x: .151, y: .15 } } : m) };
  const newer = await (await post(app, ctx.analysis.id, 'correction-sets', payload)).json() as { id: string; version: number };
  expect(newer.version).toBe(2);
  const immutable = ctx.persistence.db.select().from(correctionSets).all().map(row => [row.id, row.payload]);
  const current = await ctx.workflow.get(ctx.analysis.id);
  const expected = { updatedAt: current.updatedAt, acceptedCorrectionSetId: current.acceptedCorrectionSetId };
  const selections = await Promise.all([post(app, ctx.analysis.id, `correction-sets/${ctx.correction.id}/accept`, expected), post(app, ctx.analysis.id, `correction-sets/${newer.id}/accept`, expected)]);
  expect(selections.map(r => r.status).sort()).toEqual([200, 400]);
  expect((await ctx.workflow.get(ctx.analysis.id)).acceptedCorrectionSetId).toBe(ctx.correction.id);
  expect(ctx.persistence.db.select().from(correctionSets).all().map(row => [row.id, row.payload])).toEqual(immutable);
  expect((await post(app, ctx.analysis.id, `correction-sets/${newer.id}/accept`, expected)).status).toBe(400);
  const selected = await ctx.workflow.get(ctx.analysis.id);
  const authority = { updatedAt: selected.updatedAt, acceptedCorrectionSetId: selected.acceptedCorrectionSetId };
  expect((await post(app, ctx.analysis.id, 'correction-sets/deleted-version/accept', authority)).status).toBe(400);
  await post(app, ctx.analysis.id, 'queue'); await post(app, ctx.analysis.id, 'start');
  expect((await post(app, ctx.analysis.id, `correction-sets/${newer.id}/accept`, authority)).status).toBe(400);
  await expect.poll(async () => (await ctx.workflow.get(ctx.analysis.id)).state).toBe('needs_correction');
  expect((await ctx.persistence.getRun(ctx.analysis.id))?.correctionSetId).toBe(ctx.correction.id);
  expect(ctx.persistence.db.select().from(correctionSets).all().map(row => [row.id, row.payload])).toEqual(immutable);
  await post(app, ctx.analysis.id, 'calibration/start');
  const editing = await ctx.workflow.get(ctx.analysis.id);
  const editingAuthority = { updatedAt: editing.updatedAt, acceptedCorrectionSetId: editing.acceptedCorrectionSetId };
  const saveAgainstSelection = app.request(`http://localhost/analyses/${ctx.analysis.id}/correction-sets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-analysis-updated-at': editing.updatedAt, 'x-accepted-correction-set-id': editing.acceptedCorrectionSetId ?? 'null' }, body: JSON.stringify(payload) });
  const selectedAgainstSave = post(app, ctx.analysis.id, `correction-sets/${ctx.correction.id}/accept`, editingAuthority);
  const competing = await Promise.all([saveAgainstSelection, selectedAgainstSave]);
  expect(competing.filter(response => response.ok)).toHaveLength(1);
  expect(competing.filter(response => response.status === 400)).toHaveLength(1);
  expect((await ctx.workflow.get(ctx.analysis.id)).state).toBe('ready');
  // Hold a lifecycle snapshot across a competing correction transaction.
  const queueSnapshot = await ctx.workflow.get(ctx.analysis.id);
  const otherCorrectionId = queueSnapshot.acceptedCorrectionSetId === newer.id ? ctx.correction.id : newer.id;
  await ctx.workflow.selectCorrectionSet(ctx.analysis.id, otherCorrectionId, { updatedAt: queueSnapshot.updatedAt, acceptedCorrectionSetId: queueSnapshot.acceptedCorrectionSetId ?? null });
  await expect(ctx.persistence.save({ ...queueSnapshot, state: 'queued' })).rejects.toThrow('authority changed');
  expect(await ctx.workflow.get(ctx.analysis.id)).toMatchObject({ state: 'ready', acceptedCorrectionSetId: otherCorrectionId });
  await ctx.workflow.queue(ctx.analysis.id);
  expect(await ctx.workflow.get(ctx.analysis.id)).toMatchObject({ state: 'queued', acceptedCorrectionSetId: otherCorrectionId });
  await expect(ctx.workflow.selectCorrectionSet(ctx.analysis.id, ctx.correction.id, { updatedAt: queueSnapshot.updatedAt, acceptedCorrectionSetId: queueSnapshot.acceptedCorrectionSetId ?? null })).rejects.toThrow('authority changed');
  const foreign = await ctx.workflow.createDraft({ videoPath: ctx.analysis.videoPath, videoName: 'other.webm', videoStorage: 'local-disk', localVideoRef: ctx.analysis.localVideoRef });
  const currentAgain = await ctx.workflow.get(ctx.analysis.id);
  expect((await post(app, foreign.id, `correction-sets/${ctx.correction.id}/accept`, { updatedAt: foreign.updatedAt, acceptedCorrectionSetId: null })).status).toBe(400);
  ctx.persistence.db.delete(analyses).where(eq(analyses.id, foreign.id)).run();
  expect((await app.request(`http://localhost/analyses/${foreign.id}`)).status).toBe(404);
  expect((await (await app.request('http://localhost/analyses')).json() as { analyses: Array<{ id: string }> }).analyses.some(row => row.id === foreign.id)).toBe(false);
  const reopened = new LocalPersistence(join(ctx.root, 'metadata.sqlite'), resolve('api/drizzle/local-migrations'));
  try {
    const reopenedApp = createLocalApp(new AnalysisWorkflow(reopened), reopened, new LocalArtifactStore(ctx.artifacts.root, reopened), ctx.videos, async () => undefined);
    expect((await (await reopenedApp.request('http://localhost/analyses')).json() as { analyses: unknown[] }).analyses).toContainEqual(currentAgain);
  } finally { reopened.close(); }
  await rm(ctx.videos.resolvePath(ctx.analysis.videoPath));
  expect((await app.request(`http://localhost/analyses/${ctx.analysis.id}/video`)).status).toBe(404);
  expect((await app.request(`http://localhost/analyses/${ctx.analysis.id}`)).status).toBe(200);

});
